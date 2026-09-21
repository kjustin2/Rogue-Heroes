# =============================================================================
#  VEHICLES KIT — Blender-authored hulls for every vehicle and structure, as PARTS.
# -----------------------------------------------------------------------------
#  The tank, APC, artillery, HQ, gun turret and the crate / sandbag / barricade
#  cover used to be Meshy hulls: photoreal PBR meshes posterized at load and
#  stood next to the flat-banded, inked troopers as a different game. This kit
#  replaces them with low-poly, flat-shaded, bevelled hard-surface shapes in the
#  same language as the infantry kit (Advance Wars Re-Boot Camp / Into the
#  Breach readability: chunky silhouettes, a few strong greebles per hull, no
#  texture).
#
#  ONE MESH PER DAMAGE-MODEL PART. A vehicle is a rig of separate meshes in the
#  game — `createTank` in damageModel.ts has hull / turret / cannon / left-tread /
#  right-tread / front-plate — and per-part damage, cannon recoil, dead-track
#  listing and the pooled team paint all key off that. So this script authors
#  `tank-hull`, `tank-turret`, `tank-cannon`, `tank-track` (placed at ±x for the
#  two treads), `tank-front`, and so on, and worldRenderer.ts assembles them
#  through the same `box(..., { geometry })` path the props kit uses. Small
#  emissive accents (headlamps, team stripe, cupola lamp, HQ banner and windows)
#  stay procedural boxes: a pooled part material is ONE colour.
#
#  AUTHORED AT GAME SCALE, IN GAME COORDINATES. Every helper here takes game
#  space (x right, y up, z forward = the direction the gun points) and converts
#  to Blender's Z-up frame; the exporter's Y-up swap puts it back. Each part is
#  exported normalised to a 1x1x1 cube like every other kit part, and this
#  script ALSO writes src/render/vehiclesLayout.ts with each part's authored
#  bounding box (size + centre), so the renderer scales the unit cube back to
#  exactly where it was authored. Shape AND proportion live here for vehicles —
#  a hull's parts have to fit each other, which a per-part `size` in TS cannot
#  guarantee. Team colour, accents and animation stay in TS.
#
#  Same contract as the other kits: UVs + Cycles vertex AO in COLOR_0, no
#  materials, validated by ../infantry/validate.py before export, and the game
#  keeps its procedural builders as the fallback when the GLB is missing.
#
#  Run:  npm run art:vehicles     (from game/)
#  Out:  game/public/models/vehicles-kit.glb + game/src/render/vehiclesLayout.ts
# =============================================================================
import json
import math
import os
import sys

import bpy
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "infantry"))
sys.path.insert(0, os.path.join(HERE, "..", "props"))
import author_kit  # noqa: E402
import author_props  # noqa: E402
import validate  # noqa: E402
from author_kit import join  # noqa: E402

OUT = os.path.join(HERE, "..", "..", "public", "models", "vehicles-kit.glb")
LAYOUT_TS = os.path.join(HERE, "..", "..", "src", "render", "vehiclesLayout.ts")
TRI_BUDGET = 2400
LAYOUT = {}

# Bevel widths (game metres). Chunky on hull plates, fine on gun tubes and bags.
BEVEL_HULL = 0.035
BEVEL_FINE = 0.018


# ----------------------------------------------------------------------------- game-space helpers
def G(x, y, z):
    """Game (x, y up, z forward) -> Blender (x, -z, y)."""
    return (x, -z, y)


def gbox(name, size, at, pitch=0.0, yaw=0.0, roll=0.0):
    """A box in GAME coordinates: size (sx, sy, sz), centre (x, y, z). pitch rotates about game x
    (negative = top leans back, the glacis slope), yaw about game y, roll about game z."""
    sx, sy, sz = size
    obj = author_kit.add_box(name, (sx, sz, sy), location=G(*at))
    # add_box leaves the mesh in WORLD coordinates (measured: an object-level rotation here spun
    # the box about the world origin, not its own centre), so orientation is applied to the
    # vertices about the box's centre, and the object transform is left at identity.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if pitch or yaw or roll:
        _pivot_rotate(obj, at, pitch, yaw, roll)
    return obj


def gcyl(name, radius, length, at, axis="y", vertices=12, radius_end=None, pitch=0.0):
    """A cylinder along a GAME axis: 'y' (vertical), 'z' (a gun barrel, forward), 'x' (a wheel).
    `radius_end` tapers the +axis end (a muzzle, a dish); `pitch` tilts it about its own centre.
    author_props.cyl bakes location + rotation into the mesh, so the result is world-space."""
    rot = {"y": (0, 0, 0), "z": (math.radians(90), 0, 0), "x": (0, math.radians(90), 0)}[axis]
    obj = author_props.cyl(name, radius, length, location=G(*at), rotation=rot, vertices=vertices, radius_top=radius_end)
    if pitch:
        _pivot_rotate(obj, at, pitch)
    return obj


def gico(name, radius, at, scale=(1, 1, 1), subdiv=1):
    sx, sy, sz = scale
    return author_props.ico(name, radius=radius, subdiv=subdiv, location=G(*at), scale=(sx, sz, sy))


def bbox_game(obj):
    """Authored bounding box in GAME units: (size, centre)."""
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    lo = Vector((min(xs), min(ys), min(zs)))
    hi = Vector((max(xs), max(ys), max(zs)))
    size = hi - lo
    c = (hi + lo) * 0.5
    # Blender (x, y, z) -> game (x, z, -y)
    return (size.x, size.z, size.y), (c.x, c.z, -c.y)


def part(objs, name, bevel=BEVEL_HULL):
    """Join the primitives into one part, record its authored bbox, then the shared kit finish:
    UVs, bevel, FLAT shading (one toon band per facet), vertex AO, normalise to the unit cube."""
    obj = join(objs, name) if len(objs) > 1 else objs[0]
    obj.name = name
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)
    size, centre = bbox_game(obj)
    LAYOUT[name] = {"size": [round(v, 4) for v in size], "center": [round(v, 4) for v in centre]}
    author_kit.finish(obj, bevel=bevel, segments=2, shade_smooth=False)
    return obj


# ----------------------------------------------------------------------------- TANK
# Footprint: tracks out to x=±1.16, hull z -1.5..1.62 (3.1 long; radius 1.6 covers it), the gun
# overhangs to z≈2.7. Chunky proportions: a big rounded turret and a long gun are the tank's read.
def build_tank_track():
    # A track LOOP silhouette: an 8-sided prism along x, stretched along z, so the ends chamfer and
    # the top and bottom runs are flat. Symmetric about its own centre so one mesh serves both sides.
    loop = gcyl("loop", 0.36, 0.5, (0, 0.42, 0), axis="x", vertices=8)
    author_props.scale_xyz(loop, 1.0, 4.0, 1.0)  # Blender y == game z: stretch the loop to 2.9
    wheels = []
    for i, z in enumerate((-0.96, -0.32, 0.32, 0.96)):
        wheels.append(gcyl(f"wheel{i}", 0.26, 0.56, (0, 0.34, z), axis="x", vertices=10))
        wheels.append(gcyl(f"hub{i}", 0.12, 0.62, (0, 0.34, z), axis="x", vertices=5))
    sprocket = gcyl("sprocket", 0.2, 0.58, (0, 0.5, -1.3), axis="x", vertices=8)
    idler = gcyl("idler", 0.2, 0.58, (0, 0.5, 1.3), axis="x", vertices=8)
    fender = gbox("fender", (0.6, 0.1, 3.0), (0, 0.84, 0.02))
    return part([loop, *wheels, sprocket, idler, fender], "tank-track", bevel=BEVEL_FINE)


def build_tank_hull():
    body = gbox("body", (1.44, 0.62, 2.7), (0, 0.6, 0.0))
    deck = gbox("deck", (2.46, 0.26, 2.8), (0, 0.98, 0.0))
    engine = gbox("engine", (1.7, 0.2, 1.0), (0, 1.2, -0.85))
    ribs = [gbox(f"rib{i}", (1.5, 0.1, 0.1), (0, 1.32, -1.15 + i * 0.22)) for i in range(4)]
    exhausts = [gbox(f"ex{s}", (0.22, 0.22, 0.5), (s * 0.7, 1.1, -1.45)) for s in (-1, 1)]
    hatch = gcyl("hatch", 0.26, 0.1, (-0.45, 1.15, 0.9), axis="y", vertices=10)
    tow = [gbox(f"tow{s}", (0.14, 0.14, 0.2), (s * 0.95, 0.72, -1.42)) for s in (-1, 1)]
    return part([body, deck, engine, *ribs, *exhausts, hatch, *tow], "tank-hull")


def build_tank_front():
    # Sloped glacis (top leans back) with a lip of spare track links across it and a dozer-style
    # lower lip: the plate reads as ARMOUR, not as a bumper.
    glacis = gbox("glacis", (2.3, 0.62, 0.3), (0, 0.78, 1.42), pitch=-0.62)
    links = gbox("links", (1.3, 0.14, 0.14), (0, 1.02, 1.26), pitch=-0.62)
    lip = gbox("lip", (2.2, 0.16, 0.24), (0, 0.42, 1.52))
    return part([glacis, links, lip], "tank-front")


def build_tank_turret():
    ring = gcyl("ring", 0.78, 0.5, (0, 1.36, 0.02), axis="y", vertices=8)
    author_kit.taper(ring, 0.86)
    author_props.scale_xyz(ring, 1.0, 1.18, 1.0)  # longer than wide (Blender y == game z)
    mantlet = gbox("mantlet", (0.7, 0.42, 0.34), (0, 1.36, 0.82))
    bustle = gbox("bustle", (1.0, 0.32, 0.5), (0, 1.34, -0.78))
    cupola = gcyl("cupola", 0.24, 0.16, (0.34, 1.68, -0.12), axis="y", vertices=10)
    hatch = gcyl("hatch", 0.22, 0.08, (-0.36, 1.64, -0.05), axis="y", vertices=10)
    smoke = [gbox(f"smoke{i}", (0.1, 0.1, 0.24), (0.74, 1.5, 0.3 - i * 0.14)) for i in range(3)]
    return part([ring, mantlet, bustle, cupola, hatch, *smoke], "tank-turret")


def build_tank_cannon():
    tube = gcyl("tube", 0.11, 1.9, (0, 1.38, 1.7), axis="z", vertices=10)
    sleeve = gcyl("sleeve", 0.15, 0.7, (0, 1.38, 1.15), axis="z", vertices=10)
    brake = gbox("brake", (0.24, 0.24, 0.3), (0, 1.38, 2.5))
    return part([tube, sleeve, brake], "tank-cannon", bevel=BEVEL_FINE)


# ----------------------------------------------------------------------------- APC
# Wheeled 6x6: a tall, slab-sided troop compartment on big wheels with a small cupola gun and a
# rear ramp. Wheels (not tracks) are the one-glance difference from the tank.
def build_apc_wheels():
    parts = []
    for i, z in enumerate((-0.98, 0.0, 0.98)):
        parts.append(gcyl(f"tyre{i}", 0.38, 0.42, (0, 0.38, z), axis="x", vertices=12))
        parts.append(gcyl(f"hub{i}", 0.18, 0.5, (0, 0.38, z), axis="x", vertices=8))
    parts.append(gbox("guard", (0.5, 0.12, 2.86), (0, 0.84, 0)))
    parts.append(gbox("step", (0.34, 0.06, 0.8), (0, 0.6, -0.02)))
    return part(parts, "apc-wheels", bevel=BEVEL_FINE)


def build_apc_hull():
    lower = gbox("lower", (1.7, 0.5, 2.8), (0, 0.66, 0.0))
    box = gbox("box", (1.96, 0.9, 2.3), (0, 1.36, -0.15))
    author_kit.taper(box, 0.88)
    roof = gbox("roof", (1.6, 0.1, 1.9), (0, 1.84, -0.15))
    rail = [gbox(f"rail{s}", (0.1, 0.12, 1.5), (s * 0.7, 1.94, -0.25)) for s in (-1, 1)]
    ramp = gbox("ramp", (1.4, 0.8, 0.14), (0, 1.15, -1.36), pitch=0.12)
    hinge = gbox("hinge", (1.5, 0.12, 0.12), (0, 0.8, -1.4))
    stow = gbox("stow", (0.44, 0.22, 0.6), (-0.6, 1.98, -0.6))
    return part([lower, box, roof, *rail, ramp, hinge, stow], "apc-hull")


def build_apc_front():
    nose = gbox("nose", (1.8, 0.66, 0.34), (0, 0.9, 1.3), pitch=-0.55)
    bar = gbox("bar", (1.5, 0.08, 0.08), (0, 0.66, 1.54))
    posts = [gbox(f"post{s}", (0.08, 0.5, 0.08), (s * 0.6, 0.5, 1.54)) for s in (-1, 1)]
    winch = gbox("winch", (0.5, 0.2, 0.2), (0, 0.42, 1.42))
    return part([nose, bar, *posts, winch], "apc-front")


def build_apc_cupola():
    drum = gcyl("drum", 0.34, 0.26, (0, 2.0, 0.12), axis="y", vertices=10)
    hatch = gbox("hatch", (0.3, 0.06, 0.34), (-0.08, 2.16, 0.0))
    shield = gbox("shield", (0.5, 0.26, 0.06), (0.06, 2.22, 0.44))
    return part([drum, hatch, shield], "apc-cupola", bevel=BEVEL_FINE)


def build_apc_autogun():
    barrel = gcyl("barrel", 0.05, 0.95, (0.14, 2.14, 0.86), axis="z", vertices=8)
    receiver = gbox("receiver", (0.16, 0.16, 0.36), (0.14, 2.14, 0.34))
    feed = gbox("feed", (0.18, 0.16, 0.24), (-0.06, 2.12, 0.3))
    brake = gbox("brake", (0.12, 0.12, 0.14), (0.14, 2.14, 1.28))
    return part([barrel, receiver, feed, brake], "apc-autogun", bevel=0.01)


# ----------------------------------------------------------------------------- ARTILLERY
# A low tracked carriage with a big elevated howitzer, a rear spade and a dozer blade up front —
# long and low where the tank is tall, gun up at 25° where the tank's is level.
def build_arty_track():
    loop = gcyl("loop", 0.32, 0.5, (0, 0.38, -0.1), axis="x", vertices=8)
    author_props.scale_xyz(loop, 1.0, 4.2, 1.0)
    wheels = []
    for i, z in enumerate((-1.05, -0.35, 0.35, 1.05)):
        wheels.append(gcyl(f"wheel{i}", 0.24, 0.56, (0, 0.32, z - 0.1), axis="x", vertices=12))
        wheels.append(gcyl(f"hub{i}", 0.1, 0.62, (0, 0.32, z - 0.1), axis="x", vertices=8))
    fender = gbox("fender", (0.58, 0.08, 2.9), (0, 0.74, -0.1))
    return part([loop, *wheels, fender], "arty-track", bevel=BEVEL_FINE)


def build_arty_hull():
    carriage = gbox("carriage", (1.5, 0.5, 2.9), (0, 0.56, -0.15))
    deck = gbox("deck", (2.4, 0.2, 2.5), (0, 0.9, -0.2))
    engine = gbox("engine", (1.3, 0.36, 0.9), (0, 1.14, 0.95))
    grille = [gbox(f"grille{i}", (0.1, 0.3, 0.7), (-0.45 + i * 0.3, 1.22, 0.95)) for i in range(4)]
    spade = gbox("spade", (1.0, 0.5, 0.14), (0, 0.4, -1.72), pitch=0.5)
    arms = [gbox(f"arm{s}", (0.14, 0.14, 0.7), (s * 0.4, 0.62, -1.5)) for s in (-1, 1)]
    step = gbox("step", (0.4, 0.1, 0.6), (0.92, 0.72, 0.4))
    return part([carriage, deck, engine, *grille, spade, *arms, step], "arty-hull")


def build_arty_front():
    plate = gbox("plate", (1.9, 0.44, 0.26), (0, 0.72, 1.5), pitch=-0.7)
    blade = gbox("blade", (2.2, 0.42, 0.14), (0, 0.32, 1.7), pitch=-0.2)
    blade_arms = [gbox(f"barm{s}", (0.1, 0.1, 0.5), (s * 0.8, 0.4, 1.4)) for s in (-1, 1)]
    return part([plate, blade, *blade_arms], "arty-front")


def build_arty_mount():
    ring = gcyl("ring", 0.74, 0.24, (0, 1.1, -0.25), axis="y", vertices=12)
    cheeks = [gbox(f"cheek{s}", (0.22, 0.74, 0.86), (s * 0.44, 1.48, -0.3)) for s in (-1, 1)]
    cross = gbox("cross", (1.1, 0.16, 0.3), (0, 1.22, -0.55))
    trunnion = gcyl("trunnion", 0.14, 1.1, (0, 1.6, -0.3), axis="x", vertices=10)
    return part([ring, *cheeks, cross, trunnion], "arty-mount")


ARTY_ELEV = math.radians(24)


def build_arty_gun():
    # The elevation is BAKED into the mesh: an SPG parks with its tube up, and that raised line is
    # the silhouette. Trunnion at (0, 1.6, -0.3); barrel 2.9 long from there.
    L = 2.9
    pivot = (0, 1.6, -0.3)
    # Everything is built level along +z from the trunnion, then swung up about it.
    tube = gcyl("tube", 0.13, L, (0, 1.6, -0.3 + L / 2 - 0.3), axis="z", vertices=10)
    breech = gbox("breech", (0.46, 0.44, 0.7), (0, 1.6, -0.55))
    recoil = [gcyl(f"recoil{s}", 0.07, 0.9, (s * 0.2, 1.72, 0.2), axis="z", vertices=8) for s in (-1, 1)]
    brake = gbox("brake", (0.36, 0.36, 0.4), (0, 1.6, -0.3 + L - 0.5))
    pieces = [tube, breech, *recoil, brake]
    for p in pieces:
        _pivot_rotate(p, pivot, -ARTY_ELEV)
    return part(pieces, "arty-gun", bevel=BEVEL_FINE)


def _pivot_rotate(obj, pivot_game, pitch, yaw=0.0, roll=0.0):
    """Rotate a (transform-applied) mesh about a game-space pivot: pitch about game x, yaw about
    game y, roll about game z (game x/y/z map to Blender X/Z/-Y). Used for glacis slopes and to
    swing the howitzer parts up about the trunnion. Mesh coordinates are Blender space."""
    p = Vector(G(*pivot_game))
    m = Euler((pitch, -roll, yaw), "XYZ").to_matrix()
    for v in obj.data.vertices:
        v.co = p + m @ (v.co - p)


# ----------------------------------------------------------------------------- GUN TURRET
def build_turret_mount():
    plinth = gcyl("plinth", 0.9, 0.3, (0, 0.15, 0), axis="y", vertices=8)
    ring = gcyl("ring", 0.56, 0.34, (0, 0.46, 0), axis="y", vertices=12)
    collar = gcyl("collar", 0.62, 0.08, (0, 0.66, 0), axis="y", vertices=12)
    feet = [gbox(f"foot{i}", (0.2, 0.3, 0.2), (math.cos(a) * 0.68, 0.18, math.sin(a) * 0.68)) for i, a in enumerate((0.785, 2.356, 3.927, 5.498))]
    return part([plinth, ring, collar, *feet], "turret-mount")


def build_turret_gun():
    housing = gbox("housing", (0.84, 0.46, 0.9), (0, 0.9, -0.05))
    author_kit.taper(housing, 0.9)
    barrels = [gcyl(f"barrel{s}", 0.06, 1.1, (s * 0.15, 0.94, 0.9), axis="z", vertices=8) for s in (-1, 1)]
    brakes = [gbox(f"brake{s}", (0.14, 0.14, 0.18), (s * 0.15, 0.94, 1.42)) for s in (-1, 1)]
    belt = gbox("belt", (0.26, 0.26, 0.46), (0.5, 1.0, 0.02))
    shield = gbox("shield", (1.0, 0.5, 0.06), (0, 1.02, 0.42))
    return part([housing, *barrels, *brakes, belt, shield], "turret-gun", bevel=BEVEL_FINE)


def build_turret_sensor():
    head = gbox("head", (0.32, 0.24, 0.3), (-0.34, 1.34, -0.14))
    mast = gcyl("mast", 0.03, 0.4, (-0.34, 1.62, -0.14), axis="y", vertices=6)
    dish = gcyl("dish", 0.16, 0.06, (-0.34, 1.82, -0.14), axis="y", vertices=10, radius_end=0.04)
    return part([head, mast, dish], "turret-sensor", bevel=0.01)


# ----------------------------------------------------------------------------- HQ (base)
def build_hq_core():
    plinth = gbox("plinth", (3.0, 0.26, 2.6), (0, 0.13, 0))
    step = gbox("step", (2.62, 0.34, 2.24), (0, 0.4, 0))
    block = gbox("block", (2.4, 1.06, 2.02), (0, 1.06, 0))
    author_kit.taper(block, 0.94)
    buttresses = [gbox(f"but{i}", (0.3, 1.16, 0.34), (x, 1.02, z)) for i, (x, z) in enumerate(((-1.16, -0.9), (1.16, -0.9), (-1.16, 0.9), (1.16, 0.9)))]
    roof = gbox("roof", (2.66, 0.2, 2.28), (0, 1.68, 0))
    deck = gbox("deck", (1.42, 0.62, 1.24), (0.1, 2.09, 0.05))
    cap = gbox("cap", (1.56, 0.14, 1.38), (0.1, 2.46, 0.05))
    vents = [gbox(f"vent{i}", (0.3, 0.16, 0.3), (-0.9 + i * 0.5, 1.86, -0.75)) for i in range(2)]
    return part([plinth, step, block, *buttresses, roof, deck, cap, *vents], "hq-core", bevel=0.045)


def build_hq_comms():
    mast = gcyl("mast", 0.07, 1.9, (-0.92, 2.6, -0.2), axis="y", vertices=8, radius_end=0.05)
    beam = gbox("beam", (0.66, 0.08, 0.08), (-0.92, 3.34, -0.2))
    dish = gcyl("dish", 0.32, 0.1, (-0.92, 3.02, 0.02), axis="y", vertices=12, radius_end=0.1, pitch=math.radians(-55))
    base = gbox("base", (0.34, 0.24, 0.34), (-0.92, 1.9, -0.2))
    return part([mast, beam, dish, base], "hq-comms", bevel=0.012)


def build_hq_power():
    housing = gbox("housing", (0.78, 0.72, 0.7), (1.0, 0.9, -0.72))
    ribs = [gbox(f"rib{i}", (0.84, 0.1, 0.1), (1.0, 1.0, z)) for i, z in enumerate((-0.92, -0.72, -0.52))]
    stack = gcyl("stack", 0.09, 0.6, (1.32, 1.5, -0.72), axis="y", vertices=8)
    elbow = gbox("elbow", (0.4, 0.14, 0.14), (1.2, 1.28, -0.72))
    return part([housing, *ribs, stack, elbow], "hq-power", bevel=BEVEL_FINE)


def build_hq_gate():
    frame = gbox("frame", (2.7, 0.66, 0.3), (0, 0.55, 1.16))
    door = gbox("door", (1.5, 0.86, 0.16), (0, 0.63, 1.28))
    bollards = [gbox(f"bol{s}", (0.22, 0.8, 0.36), (s * 1.16, 0.5, 1.38)) for s in (-1, 1)]
    lintel = gbox("lintel", (1.7, 0.12, 0.3), (0, 1.1, 1.3))
    return part([frame, door, *bollards, lintel], "hq-gate")


# ----------------------------------------------------------------------------- COVER
def build_crates():
    # A stack: two on the ground, one up top turned a little. Every crate wears proud steel banding
    # on all four faces — a plain box read as a block of cheese at tactical zoom.
    def crate(name, size, at, yaw=0.0):
        sx, sy, sz = size
        body = gbox(name, size, at)
        pieces = [body]
        for k, dy in enumerate((-0.28, 0.28)):
            y = at[1] + dy * sy
            pieces.append(gbox(f"{name}bx{k}", (sx + 0.06, 0.08, sz + 0.06), (at[0], y, at[2])))
        for k, dx in enumerate((-0.3, 0.3)):
            pieces.append(gbox(f"{name}bz{k}", (0.08, sy + 0.06, sz + 0.06), (at[0] + dx * sx, at[1], at[2])))
        obj = join(pieces, name)
        if yaw:
            _pivot_rotate(obj, at, 0.0, yaw)
        return obj
    a = crate("a", (0.9, 0.72, 0.9), (-0.3, 0.36, 0.02))
    b = crate("b", (0.66, 0.58, 0.7), (0.5, 0.29, -0.08), yaw=0.25)
    c = crate("c", (0.66, 0.56, 0.66), (-0.22, 1.0, -0.02), yaw=-0.4)
    return part([a, b, c], "crates", bevel=0.02)


def build_sandbags():
    """A low wall of FAT bags, two courses, each bag overlapping its neighbours by a third, over a
    solid filler core. The first version was a heap of separate spheres: every gap showed the ink
    rim of the bag behind and the wall read as a honeycomb. Bags that overlap have no gaps."""
    rng = author_props._rng("sandbags", 0)
    bags = []
    for r, xs in enumerate(((-0.6, -0.2, 0.2, 0.6), (-0.4, 0.0, 0.4))):
        for i, x in enumerate(xs):
            for zi, z in enumerate((-0.16, 0.16)):
                bag = gico(f"bag{r}{i}{zi}", 0.34, (x + rng.uniform(-0.02, 0.02), 0.17 + r * 0.26, z + rng.uniform(-0.02, 0.02)),
                           scale=(0.72, 0.42, 0.62), subdiv=1)
                author_props.displace(bag, rng, amount=0.012, scale=5.0, along="radial")
                bags.append(bag)
    core = gbox("core", (1.5, 0.5, 0.5), (0, 0.26, 0))
    obj = join([*bags, core], "sandbags")
    author_props.floor(obj, 0.02)
    return part([obj], "sandbags", bevel=0.0)


def build_barricade():
    posts = [gbox(f"post{s}", (0.14, 0.86, 0.16), (s * 0.72, 0.43, 0)) for s in (-1, 1)]
    planks = [gbox(f"plank{i}", (1.76, 0.2, 0.08), (0, 0.22 + i * 0.26, 0.06 + (i % 2) * 0.04)) for i in range(3)]
    rail = gbox("rail", (1.9, 0.12, 0.22), (0, 0.86, 0))
    brace = gbox("brace", (0.1, 0.9, 0.1), (0.45, 0.4, -0.3), pitch=0.6)
    brace2 = gbox("brace2", (0.1, 0.9, 0.1), (-0.45, 0.4, -0.3), pitch=0.6)
    return part([*posts, *planks, rail, brace, brace2], "barricade", bevel=0.02)


BUILDERS = [
    build_tank_track, build_tank_hull, build_tank_front, build_tank_turret, build_tank_cannon,
    build_apc_wheels, build_apc_hull, build_apc_front, build_apc_cupola, build_apc_autogun,
    build_arty_track, build_arty_hull, build_arty_front, build_arty_mount, build_arty_gun,
    build_turret_mount, build_turret_gun, build_turret_sensor,
    build_hq_core, build_hq_comms, build_hq_power, build_hq_gate,
    build_crates, build_sandbags, build_barricade,
]


def write_layout():
    names = sorted(LAYOUT)
    lines = [
        "// GENERATED by art/vehicles/author_vehicles.py (npm run art:vehicles) — do not edit.",
        "// Each vehicles-kit part's authored bounding box in GAME units (x right, y up, z forward):",
        "// the kit mesh is a unit cube, so box(..., { geometry }) with this size at this centre puts",
        "// the part back exactly where it was authored. Shape AND proportion live in Blender for",
        "// vehicles — the parts of one hull have to fit each other.",
        'import type { VehiclesPart } from "./models";',
        "",
        "export const VEHICLE_LAYOUT: Record<VehiclesPart, { size: [number, number, number]; center: [number, number, number] }> = {",
    ]
    for n in names:
        s = LAYOUT[n]["size"]
        c = LAYOUT[n]["center"]
        lines.append(f'  "{n}": {{ size: [{s[0]}, {s[1]}, {s[2]}], center: [{c[0]}, {c[1]}, {c[2]}] }},')
    lines.append("};")
    lines.append("")
    with open(LAYOUT_TS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))
    print(f"[author_vehicles] wrote {os.path.abspath(LAYOUT_TS)}")
    print(json.dumps(LAYOUT, indent=1))


def main():
    author_kit.clear_scene()
    author_kit.setup_ao_bake()
    for build in BUILDERS:
        build()
    expected = validate.kit_part_names("VehiclesPart")
    try:
        validate.validate_scene(expected, tri_budget=TRI_BUDGET, label="vehicles kit")
    except validate.ValidationError as e:
        print("[author_vehicles] ABORTED, not exporting:", e)
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
    write_layout()
    print(f"[author_vehicles] wrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
