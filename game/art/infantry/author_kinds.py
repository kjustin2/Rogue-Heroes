# =============================================================================
#  PER-KIND INFANTRY KIT — every trooper kind gets its OWN helmet and weapon (and
#  a pack where the pack IS the unit), authored here and exported into the same
#  infantry-kit.glb as the shared chassis parts.
# -----------------------------------------------------------------------------
#  WHY. Twelve kinds shared one helmet and one rifle shape with greebles bolted on,
#  and at the distance the game is played the greebles vanish: the roster read as
#  one soldier in twelve colours. Silhouette is what survives the zoom, so each
#  kind's silhouette-carrying parts are authored as distinct SHAPES:
#
#    scout      sleek cap + whip antenna          / short folded carbine
#    sniper     hooded ghillie dome               / very long rifle, bipod, fat scope
#    striker    crested visor helm                / curved arc blade with guard
#    heavy      bucket helm with faceplate        / fat MG, shroud, ammo drum
#    grenadier  goggled crash helm                / revolver-drum launcher
#    mortar     headset cap                       / mortar tube on a baseplate
#    medic      rounded shell, cross plate        / machine pistol   + case pack
#    engineer   hard hat with lamp                / wrench-arm       + toolbox pack
#    flamer     full hood with a round lens       / twin-nozzle projector + tanks
#    droneop    visor headset with antenna        / control wand     + quad drone pack
#    sapper     welding mask                      / drum shotgun
#    jumper     aero visor                        / carbine          + thruster pack
#
#  Same contract as author_kit.py: every object is exported normalised to a 1x1x1 box
#  centred on the origin; the game scales it. Shape here, proportion in worldRenderer.
#  Local axes: X = across the trooper, Y = FORWARD (muzzle end), Z = up.
#  Run:  npm run art:kit   (author_kit.py imports and calls build_all())
# =============================================================================
import bpy
import bmesh
import math
from mathutils import Vector

from author_kit import add_box, finish, join, taper


def add_cyl(name, radius, depth, location=(0, 0, 0), rotation=(0, 0, 0), vertices=14, radius_top=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    if radius_top is not None and radius > 1e-6:
        taper(obj, radius_top / radius)
    return obj


def add_sphere(name, radius, location=(0, 0, 0), scale=(1, 1, 1), segments=18, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return obj


def add_cone(name, radius, depth, location=(0, 0, 0), rotation=(0, 0, 0), vertices=10, radius_top=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius, radius2=radius_top, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def cut_below(obj, z):
    """Slice a mesh flat at a height and drop everything under it (a helmet is a shell)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, z), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(obj.data)
    bm.free()


def rot(obj, x=0, y=0, z=0):
    obj.rotation_euler = (math.radians(x), math.radians(y), math.radians(z))
    bpy.ops.object.transform_apply(rotation=True)
    return obj


# ----------------------------------------------------------------------------- helmets
def helmet_scout():
    cap = add_sphere("cap", 0.5, scale=(0.94, 1.1, 0.72))
    cut_below(cap, -0.02)
    visor = add_box("visor", (0.82, 0.34, 0.08), location=(0, 0.5, 0.02))
    rot(visor, x=-16)
    ant = add_cyl("ant", 0.035, 0.9, location=(0.36, -0.2, 0.55), vertices=6)
    obj = join([cap, visor, ant], "helmet-scout")
    finish(obj, bevel=0.01, angle=50)
    return obj


def helmet_sniper():
    hood = add_sphere("hood", 0.5, scale=(1.18, 1.22, 0.9))
    cut_below(hood, -0.1)
    # Ragged ghillie fringe: a ring of leaning slabs around the rim.
    parts = [hood]
    for i in range(9):
        a = i / 9 * math.tau
        slab = add_box(f"frond{i}", (0.22, 0.12, 0.34), location=(math.cos(a) * 0.52, math.sin(a) * 0.54, -0.2))
        rot(slab, x=math.degrees(math.sin(a)) * 0.25, y=-math.degrees(math.cos(a)) * 0.25, z=math.degrees(a))
        parts.append(slab)
    obj = join(parts, "helmet-sniper")
    finish(obj, bevel=0.008, angle=48)
    return obj


def helmet_striker():
    shell = add_sphere("shell", 0.5, scale=(0.9, 1.05, 0.8))
    cut_below(shell, -0.06)
    crest = add_box("crest", (0.12, 0.9, 0.42), location=(0, -0.05, 0.5))
    taper(crest, 0.4)
    visor = add_box("visor", (0.7, 0.3, 0.22), location=(0, 0.46, -0.02))
    rot(visor, x=-22)
    cheeks = [add_box(f"cheek{s}", (0.14, 0.4, 0.3), location=(s * 0.42, 0.2, -0.22)) for s in (-1, 1)]
    obj = join([shell, crest, visor] + cheeks, "helmet-striker")
    finish(obj, bevel=0.01, angle=50)
    return obj


def helmet_heavy():
    bucket = add_cyl("bucket", 0.5, 0.86, vertices=16, radius_top=0.92)
    lid = add_sphere("lid", 0.5, location=(0, 0, 0.4), scale=(1, 1, 0.34))
    cut_below(lid, 0.38)
    plate = add_box("plate", (0.8, 0.16, 0.5), location=(0, 0.48, -0.06))
    slit = add_box("slit", (0.6, 0.06, 0.07), location=(0, 0.58, 0.06))
    obj = join([bucket, lid, plate, slit], "helmet-heavy")
    finish(obj, bevel=0.012, angle=40)
    return obj


def helmet_grenadier():
    shell = add_sphere("shell", 0.5, scale=(1.0, 1.08, 0.82))
    cut_below(shell, -0.04)
    goggles = [add_cyl(f"lens{s}", 0.17, 0.12, location=(s * 0.2, 0.5, 0.06), rotation=(math.radians(90), 0, 0), vertices=12) for s in (-1, 1)]
    strap = add_box("strap", (1.02, 0.08, 0.1), location=(0, 0, 0.04))
    chin = add_box("chin", (0.9, 0.7, 0.16), location=(0, 0.1, -0.34))
    obj = join([shell, strap, chin] + goggles, "helmet-grenadier")
    finish(obj, bevel=0.01, angle=48)
    return obj


def helmet_mortar():
    cap = add_sphere("cap", 0.5, scale=(0.96, 1.0, 0.7))
    cut_below(cap, 0.0)
    brim = add_cyl("brim", 0.56, 0.06, vertices=18)
    cups = [add_cyl(f"cup{s}", 0.2, 0.1, location=(s * 0.5, 0, -0.16), rotation=(0, math.radians(90), 0), vertices=12) for s in (-1, 1)]
    band = add_box("band", (0.12, 0.1, 0.9), location=(0, 0, 0.1))
    rot(band, y=90)
    obj = join([cap, brim, band] + cups, "helmet-mortar")
    finish(obj, bevel=0.01, angle=48)
    return obj


def helmet_medic():
    shell = add_sphere("shell", 0.5, scale=(1.0, 1.0, 0.86))
    cut_below(shell, -0.08)
    cross_a = add_box("crossA", (0.34, 0.08, 0.1), location=(0, 0.52, 0.12))
    cross_b = add_box("crossB", (0.1, 0.08, 0.34), location=(0, 0.52, 0.12))
    obj = join([shell, cross_a, cross_b], "helmet-medic")
    finish(obj, bevel=0.012, angle=50)
    return obj


def helmet_engineer():
    hat = add_sphere("hat", 0.5, scale=(0.92, 0.98, 0.7))
    cut_below(hat, -0.02)
    brim = add_cyl("brim", 0.6, 0.07, vertices=18)
    brim.scale = (1, 1.15, 1)
    bpy.ops.object.transform_apply(scale=True)
    lamp = add_cyl("lamp", 0.16, 0.16, location=(0, 0.5, 0.18), rotation=(math.radians(90), 0, 0), vertices=12)
    obj = join([hat, brim, lamp], "helmet-engineer")
    finish(obj, bevel=0.012, angle=46)
    return obj


def helmet_flamer():
    hood = add_sphere("hood", 0.5, scale=(1.0, 1.1, 1.0))
    cut_below(hood, -0.34)
    lens = add_cyl("lens", 0.24, 0.16, location=(0, 0.5, 0.0), rotation=(math.radians(90), 0, 0), vertices=16)
    rim = add_cyl("rim", 0.3, 0.06, location=(0, 0.46, 0.0), rotation=(math.radians(90), 0, 0), vertices=16)
    filt = add_cyl("filter", 0.14, 0.2, location=(0.3, 0.42, -0.24), rotation=(math.radians(70), 0, math.radians(-30)), vertices=10)
    obj = join([hood, lens, rim, filt], "helmet-flamer")
    finish(obj, bevel=0.01, angle=50)
    return obj


def helmet_droneop():
    shell = add_sphere("shell", 0.5, scale=(0.94, 1.04, 0.76))
    cut_below(shell, -0.04)
    visor = add_box("visor", (0.9, 0.14, 0.18), location=(0, 0.5, 0.04))
    cup = add_cyl("cup", 0.22, 0.14, location=(0.5, 0, -0.1), rotation=(0, math.radians(90), 0), vertices=12)
    ant = add_cyl("ant", 0.03, 0.7, location=(0.5, -0.1, 0.3), vertices=6)
    rot(ant, y=-20)
    obj = join([shell, visor, cup, ant], "helmet-droneop")
    finish(obj, bevel=0.01, angle=48)
    return obj


def helmet_sapper():
    shell = add_sphere("shell", 0.5, scale=(0.96, 1.0, 0.8))
    cut_below(shell, -0.02)
    mask = add_box("mask", (0.84, 0.2, 0.62), location=(0, 0.48, -0.16))
    taper(mask, 0.8)
    window = add_box("window", (0.6, 0.06, 0.16), location=(0, 0.6, 0.0))
    obj = join([shell, mask, window], "helmet-sapper")
    finish(obj, bevel=0.012, angle=44)
    return obj


def helmet_jumper():
    shell = add_sphere("shell", 0.5, scale=(0.9, 1.16, 0.78))
    cut_below(shell, -0.08)
    visor = add_box("visor", (0.78, 0.36, 0.2), location=(0, 0.42, -0.02))
    rot(visor, x=-30)
    fin = add_box("fin", (0.08, 0.6, 0.3), location=(0, -0.24, 0.42))
    taper(fin, 0.3)
    obj = join([shell, visor, fin], "helmet-jumper")
    finish(obj, bevel=0.01, angle=50)
    return obj


# ----------------------------------------------------------------------------- weapons
def weapon_carbine():
    receiver = add_box("receiver", (0.24, 0.5, 0.26))
    barrel = add_cyl("barrel", 0.05, 0.4, location=(0, 0.44, 0.04), rotation=(math.radians(90), 0, 0))
    mag = add_box("mag", (0.14, 0.18, 0.3), location=(0, 0.04, -0.24))
    rot(mag, x=10)
    stock = add_box("stock", (0.08, 0.36, 0.08), location=(0, -0.4, 0.0))  # folded skeleton stock
    grip = add_box("grip", (0.12, 0.12, 0.22), location=(0, -0.12, -0.2))
    obj = join([receiver, barrel, mag, stock, grip], "weapon-carbine")
    finish(obj, bevel=0.008, angle=46)
    return obj


def weapon_longrifle():
    receiver = add_box("receiver", (0.18, 0.5, 0.22), location=(0, -0.1, 0))
    barrel = add_cyl("barrel", 0.04, 1.3, location=(0, 0.6, 0.02), rotation=(math.radians(90), 0, 0))
    brake = add_box("brake", (0.1, 0.16, 0.1), location=(0, 1.22, 0.02))
    scope = add_cyl("scope", 0.09, 0.5, location=(0, 0.0, 0.2), rotation=(math.radians(90), 0, 0), vertices=12)
    stock = add_box("stock", (0.16, 0.5, 0.26), location=(0, -0.58, -0.06))
    taper(stock, 0.8)
    bip = [add_cyl(f"bip{s}", 0.025, 0.36, location=(s * 0.14, 0.62, -0.18), rotation=(0, math.radians(s * 18), 0), vertices=6) for s in (-1, 1)]
    obj = join([receiver, barrel, brake, scope, stock] + bip, "weapon-longrifle")
    finish(obj, bevel=0.006, angle=46)
    return obj


def weapon_blade():
    # A curved arc blade: a bent slab with an edge taper, a guard and a wrapped grip.
    blade = add_box("blade", (0.05, 1.2, 0.3), location=(0, 0.5, 0))
    bm = bmesh.new()
    bm.from_mesh(blade.data)
    for v in bm.verts:
        t = (v.co.y + 0.1) / 1.2
        v.co.z += math.sin(t * math.pi) * 0.22       # the curve
        v.co.x *= 1.0 - 0.7 * max(0.0, v.co.z - 0.1)  # thin toward the edge
    bm.to_mesh(blade.data)
    bm.free()
    guard = add_box("guard", (0.34, 0.08, 0.16), location=(0, -0.14, 0))
    grip = add_cyl("grip", 0.05, 0.4, location=(0, -0.38, 0), rotation=(math.radians(90), 0, 0), vertices=8)
    pommel = add_sphere("pommel", 0.07, location=(0, -0.6, 0), segments=10, rings=6)
    obj = join([blade, guard, grip, pommel], "weapon-blade")
    finish(obj, bevel=0.006, angle=40)
    return obj


def weapon_mg():
    receiver = add_box("receiver", (0.3, 0.7, 0.34))
    barrel = add_cyl("barrel", 0.07, 0.7, location=(0, 0.66, 0.06), rotation=(math.radians(90), 0, 0))
    shroud = add_cyl("shroud", 0.12, 0.5, location=(0, 0.6, 0.06), rotation=(math.radians(90), 0, 0), vertices=10)
    drum = add_cyl("drum", 0.2, 0.18, location=(0.24, -0.02, -0.06), rotation=(0, math.radians(90), 0), vertices=14)
    stock = add_box("stock", (0.22, 0.4, 0.26), location=(0, -0.52, -0.04))
    taper(stock, 0.85)
    handle = add_box("handle", (0.08, 0.3, 0.1), location=(0, 0.0, 0.26))
    obj = join([receiver, barrel, shroud, drum, stock, handle], "weapon-mg")
    finish(obj, bevel=0.008, angle=44)
    return obj


def weapon_launcher():
    tube = add_cyl("tube", 0.11, 0.9, location=(0, 0.3, 0.02), rotation=(math.radians(90), 0, 0), vertices=14)
    bell = add_cyl("bell", 0.11, 0.16, location=(0, 0.82, 0.02), rotation=(math.radians(90), 0, 0), vertices=14, radius_top=1.35)
    drum = add_cyl("drum", 0.24, 0.26, location=(0, -0.1, -0.02), rotation=(math.radians(90), 0, 0), vertices=8)
    stock = add_box("stock", (0.16, 0.4, 0.2), location=(0, -0.5, -0.06))
    grip = add_box("grip", (0.1, 0.12, 0.24), location=(0, 0.1, -0.24))
    obj = join([tube, bell, drum, stock, grip], "weapon-launcher")
    finish(obj, bevel=0.008, angle=44)
    return obj


def weapon_mortar():
    tube = add_cyl("tube", 0.13, 1.0, location=(0, 0.2, 0.2), rotation=(math.radians(55), 0, 0), vertices=14)
    plate = add_box("plate", (0.6, 0.6, 0.08), location=(0, -0.2, -0.3))
    legs = [add_cyl(f"leg{s}", 0.03, 0.6, location=(s * 0.22, 0.34, -0.02), rotation=(math.radians(-30), 0, math.radians(s * 20)), vertices=6) for s in (-1, 1)]
    sight = add_box("sight", (0.06, 0.12, 0.16), location=(0.16, 0.02, 0.36))
    obj = join([tube, plate, sight] + legs, "weapon-mortar")
    finish(obj, bevel=0.008, angle=44)
    return obj


def weapon_pistol():
    slide = add_box("slide", (0.16, 0.5, 0.16), location=(0, 0.1, 0.06))
    grip = add_box("grip", (0.14, 0.18, 0.34), location=(0, -0.16, -0.16))
    rot(grip, x=14)
    mag = add_box("mag", (0.1, 0.12, 0.3), location=(0, 0.16, -0.2))
    obj = join([slide, grip, mag], "weapon-pistol")
    finish(obj, bevel=0.008, angle=46)
    return obj


def weapon_wrench():
    shaft = add_cyl("shaft", 0.05, 0.9, location=(0, 0.1, 0), rotation=(math.radians(90), 0, 0), vertices=8)
    head = add_box("head", (0.34, 0.26, 0.12), location=(0, 0.62, 0))
    jaw = add_box("jaw", (0.12, 0.2, 0.12), location=(0.1, 0.8, 0))
    torch = add_cone("torch", 0.06, 0.2, location=(0, -0.44, 0), rotation=(math.radians(-90), 0, 0))
    obj = join([shaft, head, jaw, torch], "weapon-wrench")
    finish(obj, bevel=0.008, angle=44)
    return obj


def weapon_flamethrower():
    body = add_box("body", (0.24, 0.7, 0.28))
    nozzles = [add_cyl(f"nozzle{s}", 0.06, 0.5, location=(s * 0.08, 0.6, 0.04), rotation=(math.radians(90), 0, 0), vertices=10) for s in (-1, 1)]
    cage = add_cyl("cage", 0.14, 0.2, location=(0, 0.86, 0.04), rotation=(math.radians(90), 0, 0), vertices=10, radius_top=1.3)
    tank = add_cyl("tank", 0.1, 0.5, location=(0, -0.2, -0.22), rotation=(math.radians(90), 0, 0), vertices=12)
    grip = add_box("grip", (0.1, 0.12, 0.24), location=(0, -0.44, -0.16))
    obj = join([body, cage, tank, grip] + nozzles, "weapon-flamethrower")
    finish(obj, bevel=0.008, angle=44)
    return obj


def weapon_wand():
    stem = add_cyl("stem", 0.04, 0.9, location=(0, 0.1, 0), rotation=(math.radians(90), 0, 0), vertices=8)
    dish = add_cyl("dish", 0.22, 0.06, location=(0, 0.6, 0), rotation=(math.radians(90), 0, 0), vertices=14, radius_top=0.5)
    slate = add_box("slate", (0.3, 0.4, 0.06), location=(0, -0.2, 0.1))
    obj = join([stem, dish, slate], "weapon-wand")
    finish(obj, bevel=0.008, angle=46)
    return obj


def weapon_shotgun():
    receiver = add_box("receiver", (0.24, 0.6, 0.26))
    barrels = [add_cyl(f"bbl{s}", 0.06, 0.6, location=(s * 0.07, 0.6, 0.06), rotation=(math.radians(90), 0, 0), vertices=10) for s in (-1, 1)]
    drum = add_cyl("drum", 0.22, 0.24, location=(0, 0.06, -0.2), rotation=(0, math.radians(90), 0), vertices=14)
    stock = add_box("stock", (0.2, 0.4, 0.26), location=(0, -0.48, -0.04))
    taper(stock, 0.8)
    obj = join([receiver, drum, stock] + barrels, "weapon-shotgun")
    finish(obj, bevel=0.008, angle=44)
    return obj


# ----------------------------------------------------------------------------- packs
def pack_medic():
    case = add_box("case", (0.9, 0.44, 0.7))
    lid = add_box("lid", (0.92, 0.46, 0.16), location=(0, 0, 0.42))
    cross_a = add_box("crossA", (0.4, 0.08, 0.1), location=(0, -0.26, 0.0))
    cross_b = add_box("crossB", (0.1, 0.08, 0.4), location=(0, -0.26, 0.0))
    obj = join([case, lid, cross_a, cross_b], "pack-medic")
    finish(obj, bevel=0.014, angle=44)
    return obj


def pack_engineer():
    box = add_box("box", (0.9, 0.5, 0.6), location=(0, 0, -0.1))
    handle = add_box("handle", (0.5, 0.1, 0.12), location=(0, 0, 0.36))
    tank = add_cyl("tank", 0.16, 0.7, location=(0.5, 0, 0.0), vertices=12)
    hose = add_cyl("hose", 0.04, 0.5, location=(0.5, -0.3, 0.4), rotation=(math.radians(60), 0, 0), vertices=6)
    obj = join([box, handle, tank, hose], "pack-engineer")
    finish(obj, bevel=0.012, angle=44)
    return obj


def pack_flamer():
    tanks = [add_cyl(f"tank{s}", 0.22, 0.9, location=(s * 0.26, 0, 0), vertices=14) for s in (-1, 1)]
    caps = [add_sphere(f"cap{s}", 0.22, location=(s * 0.26, 0, 0.45), scale=(1, 1, 0.5), segments=14, rings=6) for s in (-1, 1)]
    frame = add_box("frame", (1.0, 0.16, 0.2), location=(0, -0.2, -0.2))
    obj = join(tanks + caps + [frame], "pack-flamer")
    finish(obj, bevel=0.012, angle=44)
    return obj


def pack_drone():
    hull = add_box("hull", (0.5, 0.5, 0.18))
    arms = [add_box(f"arm{i}", (0.7, 0.08, 0.06), location=(0, 0, 0.02)) for i in range(2)]
    rot(arms[0], z=45)
    rot(arms[1], z=-45)
    rotors = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            rotors.append(add_cyl(f"rotor{sx}{sy}", 0.2, 0.03, location=(sx * 0.42, sy * 0.42, 0.08), vertices=12))
    eye = add_sphere("eye", 0.1, location=(0, 0.3, -0.06), segments=10, rings=6)
    obj = join([hull, eye] + arms + rotors, "pack-drone")
    finish(obj, bevel=0.008, angle=44)
    return obj


def pack_jumper():
    frame = add_box("frame", (0.9, 0.3, 0.7), location=(0, 0, 0.1))
    bells = []
    for s in (-1, 1):
        bells.append(add_cyl(f"bell{s}", 0.2, 0.7, location=(s * 0.3, 0.05, -0.1), rotation=(math.radians(-14), 0, math.radians(s * 12)), vertices=14))
        bells.append(add_cyl(f"nozzle{s}", 0.2, 0.18, location=(s * 0.34, 0.14, -0.5), rotation=(math.radians(-14), 0, math.radians(s * 12)), vertices=14, radius_top=1.35))
    obj = join([frame] + bells, "pack-jumper")
    finish(obj, bevel=0.012, angle=44)
    return obj


BUILDERS = [
    helmet_scout, helmet_sniper, helmet_striker, helmet_heavy, helmet_grenadier, helmet_mortar,
    helmet_medic, helmet_engineer, helmet_flamer, helmet_droneop, helmet_sapper, helmet_jumper,
    weapon_carbine, weapon_longrifle, weapon_blade, weapon_mg, weapon_launcher, weapon_mortar,
    weapon_pistol, weapon_wrench, weapon_flamethrower, weapon_wand, weapon_shotgun,
    pack_medic, pack_engineer, pack_flamer, pack_drone, pack_jumper,
]


def build_all():
    for build in BUILDERS:
        build()
