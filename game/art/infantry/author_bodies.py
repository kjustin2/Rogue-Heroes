# =============================================================================
#  PER-KIND BODIES — "the infantry units still look a bit basic; make them more
#  exciting and unique per unit."
# -----------------------------------------------------------------------------
#  A helmet and a weapon on a shared body is a uniform with a hat. What makes a
#  CHARACTER is the body itself: a heavy has a barrel chest and shelf pauldrons, a
#  scout a cropped jacket and a scarf, a flamer is a hazmat barrel wrapped in hose.
#  So every kind now gets its own TORSO (and where the read needs it, its own ARM
#  or LEG), authored as a variant of the chassis part under the SAME rig contract:
#  same part id, same pivot, same unit-cube normalisation. The walk cycle, the
#  pooled paint and per-part damage never know the difference. Plus two or three
#  EXTRA parts per kind that hang off an existing part id (a cape on the torso,
#  hoses on the pack, a sheath on the hips) so they move with the rig for free.
#
#  Imported by author_kinds.py (which author_kit.py imports); every builder here is
#  appended to author_kinds.BUILDERS. Same axes: X across, Y FORWARD, Z up.
# =============================================================================
import bpy
import math

from author_kit import add_box, finish, join, taper
from author_kinds import add_cyl, add_sphere, add_cone, cut_below, rot


# ----------------------------------------------------------------------------- torso pieces
def _chest(width=0.9, depth=0.6, height=0.86, top=1.16, z=0.02):
    body = add_box("torso", (width, depth, height), location=(0, 0, z))
    taper(body, top)
    return body


def _abdomen(width=0.72, depth=0.5):
    ab = add_box("abdomen", (width, depth, 0.3), location=(0, 0.02, -0.46))
    taper(ab, 1.1)
    return ab


def _belt(width=0.8, depth=0.56):
    return add_box("belt", (width, depth, 0.08), location=(0, 0.02, -0.6))


def _collar(r=0.26):
    return add_cyl("collar", r, 0.12, location=(0, 0.0, 0.5), vertices=14)


def _straps(angle=-14, x=0.28):
    out = []
    for s in (-1, 1):
        st = add_box(f"strap{s}", (0.12, 0.1, 0.5), location=(s * x, 0.3, 0.26))
        rot(st, x=angle)
        out.append(st)
    return out


def _ring_of_slabs(prefix, count, radius, z, size, lean=0.25, phase=0.0, ry=0.54, keep=None):
    """A ragged ring of leaning slabs (ghillie fringe, cape hem, fur ruff). `keep(i, angle)`
    filters which slabs are built, so a ring can be open at the front."""
    out = []
    for i in range(count):
        a = phase + i / count * math.tau
        if keep is not None and not keep(i, a):
            continue
        slab = add_box(f"{prefix}{i}", size, location=(math.cos(a) * radius, math.sin(a) * radius * (ry / 0.54), z))
        rot(slab, x=math.degrees(math.sin(a)) * lean, y=-math.degrees(math.cos(a)) * lean, z=math.degrees(a))
        out.append(slab)
    return out


# ----------------------------------------------------------------------------- torsos
def torso_heavy():
    # Barrel chest: broader, deeper, flared at the top; three armour ribs across the front; big
    # shelf pauldrons that sit ON the torso so they never float off the shoulder; a thick gorget.
    body = _chest(width=1.0, depth=0.74, height=0.9, top=1.3)
    ribs = []
    for i, z in enumerate((0.26, 0.06, -0.14)):
        rib = add_box(f"rib{i}", (0.9 + i * 0.04, 0.16, 0.13), location=(0, 0.36, z))
        rot(rib, x=-6)
        ribs.append(rib)
    shelves = []
    for s in (-1, 1):
        shelf = add_box(f"shelf{s}", (0.42, 0.62, 0.2), location=(s * 0.56, 0.0, 0.44))
        rot(shelf, y=s * 14)
        shelves.append(shelf)
        lip = add_box(f"lip{s}", (0.44, 0.64, 0.06), location=(s * 0.57, 0.0, 0.56))
        rot(lip, y=s * 14)
        shelves.append(lip)
    gorget = add_cyl("gorget", 0.32, 0.16, location=(0, 0.0, 0.52), vertices=14)
    obj = join([body, _abdomen(0.84, 0.62), _belt(0.92, 0.7), gorget] + ribs + shelves, "torso-heavy")
    finish(obj, bevel=0.014, angle=38)
    return obj


def torso_scout():
    # Slim, cropped field jacket over a narrower under-layer, an open front V, a scarf bunched at
    # the neck with a tail down the back, a radio on the left chest. Light and quick.
    jacket = _chest(width=0.78, depth=0.5, height=0.62, top=1.1, z=0.14)
    under = add_box("under", (0.62, 0.42, 0.5), location=(0, 0.0, -0.3))
    taper(under, 1.04)
    lapels = []
    for s in (-1, 1):
        lp = add_box(f"lapel{s}", (0.18, 0.08, 0.42), location=(s * 0.16, 0.26, 0.24))
        rot(lp, z=s * -22)
        lapels.append(lp)
    scarf = add_sphere("scarf", 0.3, location=(0, 0.02, 0.5), scale=(1.15, 1.0, 0.42), segments=14, rings=8)
    tail = add_box("tail", (0.22, 0.06, 0.62), location=(-0.16, -0.3, 0.2))
    rot(tail, x=8, z=-12)
    radio = add_box("radio", (0.18, 0.12, 0.24), location=(-0.24, 0.3, 0.12))
    belt = _belt(0.66, 0.46)
    obj = join([jacket, under, scarf, tail, radio, belt] + lapels, "torso-scout")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_sniper():
    # A ghillie shoulder cape: a ragged ring of fronds over the shoulders, a second lower ring
    # round the back, over a lean chest. The outline gets a shaggy hunch nothing else has.
    body = _chest(width=0.8, depth=0.54, height=0.86, top=1.1)
    fronds = _ring_of_slabs("frond", 11, 0.5, 0.3, (0.24, 0.14, 0.4), lean=0.3, ry=0.36)
    # Only the back half of the lower ring: the front stays open so the chest emblem reads.
    hem = _ring_of_slabs("hem", 8, 0.44, -0.02, (0.22, 0.12, 0.38), lean=0.2, phase=0.2, ry=0.3,
                         keep=lambda i, a: math.sin(a) < -0.2)
    hood_base = add_cyl("hoodbase", 0.3, 0.12, location=(0, 0, 0.5), vertices=14)
    obj = join([body, _abdomen(0.66, 0.46), _belt(0.72, 0.5), hood_base] + fronds + hem, "torso-sniper")
    finish(obj, bevel=0.01, angle=42)
    return obj


def torso_striker():
    # Asymmetric: a big layered guard on the SWORD shoulder (+X), a bare strap-only left shoulder,
    # a diagonal baldric from right shoulder to left hip, and a wide duelling belt.
    body = _chest(width=0.86, depth=0.58, height=0.86, top=1.12)
    guard = add_box("guard", (0.4, 0.58, 0.26), location=(0.5, 0.0, 0.42))
    rot(guard, y=18)
    guard2 = add_box("guard2", (0.36, 0.5, 0.14), location=(0.58, 0.0, 0.26))
    rot(guard2, y=26)
    spike = add_cone("spike", 0.08, 0.26, location=(0.56, 0.0, 0.62), vertices=8)
    baldric = add_box("baldric", (0.14, 0.08, 1.1), location=(0, 0.3, 0.0))
    rot(baldric, x=-4, y=32)
    belt = _belt(0.84, 0.6)
    buckle = add_box("buckle", (0.24, 0.1, 0.16), location=(0, 0.32, -0.58))
    obj = join([body, _abdomen(), belt, buckle, guard, guard2, spike, baldric, _collar(0.24)], "torso-striker")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_medic():
    # Satchel straps crossing the chest, a padded vest front, an emblem plate square on the
    # sternum for the cross, a row of dressing pouches on the belt.
    body = _chest(width=0.84, depth=0.56, height=0.86, top=1.1)
    vest = add_box("vest", (0.7, 0.14, 0.62), location=(0, 0.3, 0.04))
    rot(vest, x=-6)
    cross = []
    for s in (-1, 1):
        st = add_box(f"xstrap{s}", (0.12, 0.08, 0.96), location=(0, 0.38, 0.02))
        rot(st, x=-6, y=s * 30)
        cross.append(st)
    plate = add_box("plate", (0.34, 0.08, 0.34), location=(0, 0.42, 0.1))
    pouches = [add_box(f"dress{i}", (0.16, 0.16, 0.18), location=(x, 0.3, -0.5)) for i, x in enumerate((-0.26, 0.0, 0.26))]
    obj = join([body, _abdomen(), _belt(), vest, plate, _collar(0.24)] + cross + pouches, "torso-medic")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_engineer():
    # Tool harness: suspenders, a chest rig of three upright tool tubes, a hanging pouch each hip
    # and a big flat pocket on the belly. Work clothes, not armour.
    body = _chest(width=0.9, depth=0.58, height=0.86, top=1.1)
    susp = _straps(angle=-10, x=0.26)
    tubes = [add_cyl(f"tube{i}", 0.07, 0.34, location=(x, 0.34, 0.14), vertices=10) for i, x in enumerate((-0.2, 0.0, 0.2))]
    rig = add_box("rig", (0.6, 0.1, 0.4), location=(0, 0.3, 0.12))
    pocket = add_box("pocket", (0.5, 0.12, 0.24), location=(0, 0.3, -0.34))
    flap = add_box("flap", (0.52, 0.14, 0.08), location=(0, 0.31, -0.2))
    hips = [add_box(f"hpouch{s}", (0.16, 0.34, 0.3), location=(s * 0.5, 0.02, -0.34)) for s in (-1, 1)]
    obj = join([body, _abdomen(), _belt(), rig, pocket, flap, _collar(0.24)] + susp + tubes + hips, "torso-engineer")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_flamer():
    # Hazmat bulk: a rounded barrel with no taper, three raised seal bands, a big round valve on
    # the chest, and a hose port on the right side. Reads as a pressure vessel with legs.
    body = _chest(width=1.0, depth=0.8, height=0.92, top=1.02)
    bands = [add_box(f"band{i}", (1.04, 0.84, 0.08), location=(0, 0, z)) for i, z in enumerate((0.3, 0.0, -0.3))]
    valve = add_cyl("valve", 0.18, 0.16, location=(0, 0.44, 0.08), rotation=(math.radians(90), 0, 0), vertices=14)
    wheel = add_cyl("wheel", 0.24, 0.05, location=(0, 0.52, 0.08), rotation=(math.radians(90), 0, 0), vertices=14)
    port = add_cyl("port", 0.11, 0.2, location=(0.52, -0.1, -0.1), rotation=(0, math.radians(90), 0), vertices=10)
    neck = add_cyl("neckring", 0.34, 0.16, location=(0, 0, 0.5), vertices=16)
    obj = join([body, _abdomen(0.9, 0.7), valve, wheel, port, neck] + bands, "torso-flamer")
    finish(obj, bevel=0.014, angle=40)
    return obj


def torso_droneop():
    # Operator: slim, a chest rig carrying the control slate flat on the sternum, cable runs up to
    # the shoulder, an antenna stub on the left shoulder and a battery brick on the belt.
    body = _chest(width=0.8, depth=0.52, height=0.86, top=1.08)
    slate = add_box("slate", (0.4, 0.1, 0.3), location=(0, 0.32, 0.1))
    rot(slate, x=-12)
    cables = []
    for i, x in enumerate((-0.16, -0.08, 0.08)):
        c = add_cyl(f"cable{i}", 0.025, 0.5, location=(x, 0.3, 0.32), vertices=6)
        rot(c, x=-10)
        cables.append(c)
    stub = add_cyl("stub", 0.06, 0.22, location=(-0.36, -0.06, 0.52), vertices=8)
    brick = add_box("brick", (0.3, 0.16, 0.2), location=(0.26, 0.3, -0.5))
    obj = join([body, _abdomen(0.66, 0.46), _belt(0.72, 0.5), slate, stub, brick, _collar(0.22)] + _straps() + cables, "torso-droneop")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_sapper():
    # Bandolier of demolition charges slung diagonally, a heavy blast apron hanging over the
    # belly and a thick padded collar.
    body = _chest(width=0.9, depth=0.6, height=0.86, top=1.12)
    band = add_box("band", (0.18, 0.1, 1.1), location=(0, 0.32, 0.0))
    rot(band, y=-34)
    charges = []
    for i, t in enumerate((-0.32, -0.16, 0.0, 0.16, 0.32)):
        c = add_cyl(f"charge{i}", 0.07, 0.2, location=(-t * 0.68, 0.4, t * 1.0), rotation=(math.radians(90), 0, 0), vertices=8)
        charges.append(c)
    apron = add_box("apron", (0.62, 0.12, 0.5), location=(0, 0.3, -0.4))
    rot(apron, x=-6)
    obj = join([body, _abdomen(), _belt(), band, apron, _collar(0.28)] + charges, "torso-sapper")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_mortar():
    # Bipod carry rig: a padded shoulder saddle on the left shoulder (where the tube rides), X
    # harness straps with a chest buckle, and two round tubes on the belt.
    body = _chest(width=0.92, depth=0.62, height=0.86, top=1.14)
    saddle = add_box("saddle", (0.44, 0.56, 0.22), location=(-0.36, 0.0, 0.48))
    rot(saddle, y=-12)
    xs = []
    for s in (-1, 1):
        st = add_box(f"harness{s}", (0.12, 0.08, 0.9), location=(0, 0.34, 0.06))
        rot(st, y=s * 28)
        xs.append(st)
    buckle = add_box("buckle", (0.2, 0.1, 0.2), location=(0, 0.38, 0.06))
    rounds = [add_cyl(f"round{i}", 0.09, 0.3, location=(x, 0.3, -0.48), vertices=10) for i, x in enumerate((-0.24, 0.24))]
    obj = join([body, _abdomen(0.78, 0.54), _belt(0.86, 0.6), saddle, buckle, _collar(0.26)] + xs + rounds, "torso-mortar")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_grenadier():
    # Padded vest with fat drum-magazine pouches: two on the chest, one each hip. The unit reads
    # as "carrying a lot of round things".
    body = _chest(width=0.92, depth=0.62, height=0.86, top=1.14)
    vest = add_box("vest", (0.76, 0.16, 0.66), location=(0, 0.3, 0.02))
    rot(vest, x=-6)
    drums = [add_cyl(f"drum{i}", 0.15, 0.2, location=(x, 0.42, 0.12), rotation=(math.radians(90), 0, 0), vertices=12) for i, x in enumerate((-0.22, 0.22))]
    hips = [add_cyl(f"hdrum{s}", 0.16, 0.22, location=(s * 0.5, 0.06, -0.38), rotation=(0, math.radians(90), 0), vertices=12) for s in (-1, 1)]
    obj = join([body, _abdomen(0.8, 0.56), _belt(0.86, 0.62), vest, _collar(0.26)] + _straps() + drums + hips, "torso-grenadier")
    finish(obj, bevel=0.012, angle=40)
    return obj


def torso_jumper():
    # Flight harness: a hard chest plate with four buckle points, X straps, two shoulder mount
    # rings for the thruster pack, and a belt of buckles. Sleek and technical.
    body = _chest(width=0.82, depth=0.54, height=0.86, top=1.1)
    plate = add_box("plate", (0.56, 0.12, 0.5), location=(0, 0.3, 0.1))
    rot(plate, x=-8)
    buckles = [add_box(f"bk{i}", (0.1, 0.06, 0.1), location=(x, 0.38, z)) for i, (x, z) in enumerate(((-0.2, 0.28), (0.2, 0.28), (-0.2, -0.08), (0.2, -0.08)))]
    xs = []
    for s in (-1, 1):
        st = add_box(f"xs{s}", (0.1, 0.06, 0.9), location=(0, 0.36, 0.08))
        rot(st, y=s * 26)
        xs.append(st)
    rings = [add_cyl(f"ring{s}", 0.13, 0.1, location=(s * 0.34, -0.14, 0.5), vertices=12) for s in (-1, 1)]
    obj = join([body, _abdomen(0.68, 0.48), _belt(0.76, 0.52), plate, _collar(0.22)] + buckles + xs + rings, "torso-jumper")
    finish(obj, bevel=0.012, angle=40)
    return obj


# ----------------------------------------------------------------------------- arm / leg variants
def _arm_core(cap_r=0.3, upper_r=0.2, lower_r=0.18, glove=(0.34, 0.36, 0.28)):
    cap = add_sphere("cap", cap_r, location=(0, 0, 0.42), scale=(1, 1, 0.7), segments=14, rings=8)
    cut_below(cap, 0.3)
    upper = add_cyl("upper", upper_r, 0.5, location=(0, 0, 0.18), vertices=12)
    elbow = add_sphere("elbow", lower_r + 0.01, location=(0, 0.06, -0.08), segments=12, rings=7)
    lower = add_cyl("lower", lower_r, 0.42, location=(0, 0.1, -0.3), vertices=12)
    rot(lower, x=-14)
    gl = add_box("glove", glove, location=(0, 0.16, -0.54))
    return [cap, upper, elbow, lower, gl]


def arm_striker():
    # Bare forearm: no bracer, no elbow pad — a thinner lower arm wrapped at the wrist, with a
    # knuckle-duster glove. The asymmetry against the armoured sword shoulder is the point.
    parts = _arm_core(cap_r=0.26, upper_r=0.19, lower_r=0.15, glove=(0.3, 0.34, 0.26))
    wrap = add_cyl("wrap", 0.17, 0.12, location=(0, 0.14, -0.42), vertices=10)
    rot(wrap, x=-14)
    knuckles = add_box("knuckles", (0.3, 0.14, 0.12), location=(0, 0.3, -0.5))
    obj = join(parts + [wrap, knuckles], "arm-striker")
    finish(obj, bevel=0.012, angle=42)
    return obj


def arm_medic():
    # A broad armband high on the upper arm (the emblem lands there), a slim sleeve, a cuff.
    parts = _arm_core(cap_r=0.27, upper_r=0.19, lower_r=0.16, glove=(0.3, 0.34, 0.26))
    band = add_cyl("band", 0.235, 0.2, location=(0, 0, 0.16), vertices=14)
    cuff = add_cyl("cuff", 0.19, 0.08, location=(0, 0.14, -0.4), vertices=12)
    rot(cuff, x=-14)
    obj = join(parts + [band, cuff], "arm-medic")
    finish(obj, bevel=0.012, angle=42)
    return obj


def arm_heavy():
    # Thick: a plated upper arm sleeve, a heavy square bracer, a fist-sized gauntlet.
    parts = _arm_core(cap_r=0.34, upper_r=0.24, lower_r=0.21, glove=(0.4, 0.4, 0.3))
    sleeve = add_box("sleeve", (0.44, 0.34, 0.36), location=(0, -0.02, 0.2))
    bracer = add_box("bracer", (0.42, 0.36, 0.3), location=(0, 0.13, -0.34))
    rot(bracer, x=-14)
    obj = join(parts + [sleeve, bracer], "arm-heavy")
    finish(obj, bevel=0.012, angle=42)
    return obj


def arm_flamer():
    # Hazmat: a fat rubberised sleeve with a seal ring at the elbow and a big cuffed glove.
    parts = _arm_core(cap_r=0.32, upper_r=0.24, lower_r=0.22, glove=(0.4, 0.4, 0.32))
    seal = add_cyl("seal", 0.26, 0.1, location=(0, 0.04, -0.06), vertices=14)
    cuff = add_cyl("cuff", 0.26, 0.1, location=(0, 0.14, -0.4), vertices=14)
    rot(cuff, x=-14)
    obj = join(parts + [seal, cuff], "arm-flamer")
    finish(obj, bevel=0.012, angle=42)
    return obj


def arm_jumper():
    # A control gauntlet: a flat panel on the back of the forearm and a wrist ring.
    parts = _arm_core(cap_r=0.27, upper_r=0.19, lower_r=0.16, glove=(0.3, 0.34, 0.26))
    panel = add_box("panel", (0.28, 0.12, 0.3), location=(0, -0.06, -0.32))
    rot(panel, x=-14)
    ring = add_cyl("ring", 0.2, 0.06, location=(0, 0.14, -0.42), vertices=12)
    rot(ring, x=-14)
    obj = join(parts + [panel, ring], "arm-jumper")
    finish(obj, bevel=0.012, angle=42)
    return obj


def _leg_core(thigh_r=0.24, shin_r=0.21):
    thigh = add_cyl("thigh", thigh_r, 0.5, location=(0, 0, 0.24), vertices=12)
    knee = add_sphere("knee", shin_r - 0.01, location=(0, 0.06, -0.06), segments=12, rings=7)
    shin = add_cyl("shin", shin_r, 0.42, location=(0, 0, -0.32), vertices=12)
    cuff = add_cyl("cuff", shin_r + 0.01, 0.08, location=(0, 0, -0.52), vertices=12)
    return [thigh, knee, shin, cuff]


def leg_engineer():
    # Big square kneepads and a tool pouch strapped to the thigh; work trousers, no shin armour.
    parts = _leg_core()
    pad = add_box("kneepad", (0.36, 0.22, 0.3), location=(0, 0.2, -0.04))
    strap = add_box("strap", (0.36, 0.3, 0.06), location=(0, 0.02, 0.1))
    pouch = add_box("pouch", (0.16, 0.2, 0.26), location=(0.22, 0.14, 0.22))
    obj = join(parts + [pad, strap, pouch], "leg-engineer")
    finish(obj, bevel=0.012, angle=42)
    return obj


def leg_jumper():
    # Stabiliser fins on the calf and an armoured knee cup: landing gear.
    parts = _leg_core(thigh_r=0.22, shin_r=0.2)
    cup = add_sphere("cup", 0.22, location=(0, 0.1, -0.04), scale=(1, 0.8, 1), segments=12, rings=7)
    fins = []
    for s in (-1, 1):
        fin = add_box(f"fin{s}", (0.06, 0.3, 0.36), location=(s * 0.24, -0.12, -0.3))
        rot(fin, x=12)
        fins.append(fin)
    obj = join(parts + [cup] + fins, "leg-jumper")
    finish(obj, bevel=0.012, angle=42)
    return obj


def leg_heavy():
    # Thick armoured greaves: a thigh plate and a full shin plate.
    parts = _leg_core(thigh_r=0.27, shin_r=0.24)
    plate = add_box("thighplate", (0.42, 0.16, 0.4), location=(0, 0.2, 0.22))
    greave = add_box("greave", (0.4, 0.16, 0.44), location=(0, 0.2, -0.3))
    pad = add_box("kneepad", (0.4, 0.2, 0.22), location=(0, 0.22, -0.04))
    obj = join(parts + [plate, greave, pad], "leg-heavy")
    finish(obj, bevel=0.012, angle=42)
    return obj


def leg_scout():
    # Slim, knee wrap, a knife strapped to the thigh.
    parts = _leg_core(thigh_r=0.2, shin_r=0.17)
    wrap = add_cyl("wrap", 0.2, 0.14, location=(0, 0.02, -0.06), vertices=12)
    sheath = add_box("sheath", (0.08, 0.1, 0.36), location=(0.2, 0.08, 0.2))
    hilt = add_box("hilt", (0.12, 0.06, 0.1), location=(0.2, 0.08, 0.42))
    obj = join(parts + [wrap, sheath, hilt], "leg-scout")
    finish(obj, bevel=0.012, angle=42)
    return obj


# ----------------------------------------------------------------------------- extras
# Each hangs off an existing part id in buildSoldier so it rides the rig: a cape on the torso
# ("body"), hoses on the "pack", a sheath on the hips ("legs").
def cape_sniper():
    # A ragged ghillie cape down the back: one draped slab, tapered, with a torn hem of fronds.
    sheet = add_box("sheet", (0.9, 0.16, 1.0), location=(0, 0, 0))
    taper(sheet, 1.3)
    hem = []
    for i, x in enumerate((-0.36, -0.14, 0.1, 0.32)):
        f = add_box(f"hem{i}", (0.2, 0.14, 0.34), location=(x, 0.02 if i % 2 else -0.02, -0.56))
        rot(f, y=(-1) ** i * 10)
        hem.append(f)
    obj = join([sheet] + hem, "cape-sniper")
    finish(obj, bevel=0.01, angle=42)
    return obj


def antenna_droneop():
    # Relay pack: a flat box, a dish on a stalk and a tall whip mast with a bead.
    box = add_box("box", (0.7, 0.3, 0.6), location=(0, 0, -0.2))
    stalk = add_cyl("stalk", 0.03, 0.5, location=(0.22, 0, 0.3), vertices=6)
    dish = add_cyl("dish", 0.18, 0.05, location=(0.22, -0.06, 0.56), rotation=(math.radians(-70), 0, 0), vertices=14, radius_top=0.5)
    mast = add_cyl("mast", 0.025, 1.0, location=(-0.24, 0, 0.5), vertices=6)
    bead = add_sphere("bead", 0.05, location=(-0.24, 0, 1.0), segments=8, rings=5)
    obj = join([box, stalk, dish, mast, bead], "antenna-droneop")
    finish(obj, bevel=0.008, angle=44)
    return obj


def hose_flamer():
    # A segmented hose arcing from the tanks over the right shoulder toward the projector.
    segs = []
    n = 8
    for i in range(n):
        t = i / (n - 1)
        a = math.pi * 0.5 + t * math.pi * 0.9      # sweep from back (+) to front
        x = 0.1 + t * 0.5
        y = -math.cos(a) * 0.5
        z = math.sin(a) * 0.5 - 0.1
        seg = add_cyl(f"seg{i}", 0.06, 0.2, location=(x, y, z), vertices=8)
        rot(seg, x=math.degrees(a) - 90, y=10)
        segs.append(seg)
    coupling = add_cyl("coupling", 0.09, 0.12, location=(0.1, -0.5, -0.12), rotation=(math.radians(90), 0, 0), vertices=10)
    obj = join(segs + [coupling], "hose-flamer")
    finish(obj, bevel=0, angle=46)  # a bevel on 8 capped cylinders blew the tri budget
    return obj


def sheath_striker():
    # A long tapered scabbard with a throat and a chape, worn on the left hip.
    body = add_box("body", (0.14, 0.3, 1.0), location=(0, 0, 0))
    taper(body, 1.25)
    throat = add_box("throat", (0.2, 0.36, 0.1), location=(0, 0, 0.5))
    chape = add_cone("chape", 0.1, 0.16, location=(0, 0, -0.56), rotation=(math.radians(180), 0, 0), vertices=8)
    strap = add_box("strap", (0.3, 0.1, 0.08), location=(0, 0.14, 0.36))
    obj = join([body, throat, chape, strap], "sheath-striker")
    finish(obj, bevel=0.008, angle=44)
    return obj


def pauldron_heavy():
    # A layered, ridged pauldron: three stepped plates with a raised centre ridge.
    plates = []
    for i in range(3):
        p = add_box(f"plate{i}", (0.7 - i * 0.1, 0.9 - i * 0.14, 0.14), location=(0, 0, -0.16 + i * 0.16))
        rot(p, y=8)
        plates.append(p)
    ridge = add_box("ridge", (0.12, 0.7, 0.14), location=(0, 0, 0.26))
    obj = join(plates + [ridge], "pauldron-heavy")
    finish(obj, bevel=0.012, angle=40)
    return obj


def ammobox_heavy():
    # The back ammunition box: a drum, a feed chute and a carry frame.
    drum = add_cyl("drum", 0.34, 0.5, location=(0, 0, 0), rotation=(math.radians(90), 0, 0), vertices=16)
    chute = add_box("chute", (0.16, 0.36, 0.3), location=(0.36, 0.1, 0.1))
    frame = add_box("frame", (0.9, 0.16, 0.7), location=(0, -0.3, 0))
    obj = join([drum, chute, frame], "ammobox-heavy")
    finish(obj, bevel=0.012, angle=42)
    return obj


def stretcher_medic():
    # A rolled stretcher: two poles with a rolled canvas between them, capped.
    roll = add_cyl("roll", 0.16, 1.0, location=(0, 0, 0), vertices=14)
    poles = [add_cyl(f"pole{s}", 0.04, 1.2, location=(s * 0.14, 0.1, 0), vertices=8) for s in (-1, 1)]
    caps = [add_sphere(f"cap{i}", 0.05, location=(s * 0.14, 0.1, z), segments=6, rings=4) for i, (s, z) in enumerate(((-1, 0.6), (1, 0.6), (-1, -0.6), (1, -0.6)))]
    obj = join([roll] + poles + caps, "stretcher-medic")
    finish(obj, bevel=0, angle=44)  # round parts already; a bevel only spends tris
    return obj


def toolroll_engineer():
    # A tool roll hanging from the belt: a cylinder with a strap and two spanner heads poking out.
    roll = add_cyl("roll", 0.16, 0.7, location=(0, 0, 0), rotation=(0, math.radians(90), 0), vertices=12)
    strap = add_box("strap", (0.14, 0.36, 0.36), location=(0, 0, 0))
    heads = [add_box(f"head{i}", (0.14, 0.1, 0.18), location=(x, 0.0, 0.26)) for i, x in enumerate((-0.16, 0.18))]
    obj = join([roll, strap] + heads, "toolroll-engineer")
    finish(obj, bevel=0.01, angle=44)
    return obj


def detonator_sapper():
    # A belt-mounted detonator box with a plunger and a coil of wire.
    box = add_box("box", (0.5, 0.36, 0.44), location=(0, 0, -0.1))
    plunger = add_cyl("plunger", 0.05, 0.4, location=(0, 0, 0.3), vertices=8)
    handle = add_box("handle", (0.3, 0.08, 0.08), location=(0, 0, 0.5))
    coil = add_cyl("coil", 0.16, 0.16, location=(0.3, 0, -0.16), rotation=(0, math.radians(90), 0), vertices=12)
    obj = join([box, plunger, handle, coil], "detonator-sapper")
    finish(obj, bevel=0.01, angle=44)
    return obj


def mines_sapper():
    # A stack of three mine discs on a back frame.
    discs = [add_cyl(f"disc{i}", 0.4, 0.1, location=(0, -0.1 + i * 0.13, 0), rotation=(math.radians(90), 0, 0), vertices=16) for i in range(3)]
    frame = add_box("frame", (0.9, 0.1, 0.3), location=(0, -0.24, -0.3))
    obj = join(discs + [frame], "mines-sapper")
    finish(obj, bevel=0.01, angle=42)
    return obj


def bipod_mortar():
    # Folded bipod + baseplate strapped on the back: a round plate, two crossed legs, a clamp.
    plate = add_cyl("plate", 0.5, 0.08, location=(0, 0, 0), rotation=(math.radians(90), 0, 0), vertices=18)
    hub = add_cyl("hub", 0.16, 0.14, location=(0, -0.08, 0), rotation=(math.radians(90), 0, 0), vertices=12)
    legs = []
    for s in (-1, 1):
        lg = add_cyl(f"leg{s}", 0.035, 1.0, location=(s * 0.12, -0.14, 0.02), vertices=6)
        rot(lg, y=s * 18)
        legs.append(lg)
    clamp = add_box("clamp", (0.4, 0.12, 0.12), location=(0, -0.14, 0.42))
    obj = join([plate, hub, clamp] + legs, "bipod-mortar")
    finish(obj, bevel=0.008, angle=44)
    return obj


def drums_grenadier():
    # Two fat ammunition drums on a hip frame, one each side.
    drums = [add_cyl(f"drum{s}", 0.3, 0.26, location=(s * 0.4, 0, 0), rotation=(0, math.radians(90), 0), vertices=16) for s in (-1, 1)]
    frame = add_box("frame", (1.0, 0.18, 0.2), location=(0, -0.1, 0.06))
    obj = join(drums + [frame], "drums-grenadier")
    finish(obj, bevel=0.01, angle=42)
    return obj


def weapon_smg():
    # Jump-trooper bullpup: short and FAT — a boxy receiver with the magazine behind the grip, a
    # thick suppressor, a top carry handle. Clearly not the scout's slim carbine.
    receiver = add_box("receiver", (0.26, 0.7, 0.3), location=(0, 0.0, 0))
    mag = add_box("mag", (0.16, 0.16, 0.36), location=(0, -0.24, -0.26))
    rot(mag, x=6)
    grip = add_box("grip", (0.12, 0.12, 0.24), location=(0, 0.1, -0.24))
    supp = add_cyl("supp", 0.09, 0.44, location=(0, 0.56, 0.04), rotation=(math.radians(90), 0, 0), vertices=12)
    handle = add_box("handle", (0.08, 0.4, 0.12), location=(0, 0.0, 0.22))
    obj = join([receiver, mag, grip, supp, handle], "weapon-smg")
    finish(obj, bevel=0.008, angle=46)
    return obj


BUILDERS = [
    torso_heavy, torso_scout, torso_sniper, torso_striker, torso_medic, torso_engineer, torso_flamer,
    torso_droneop, torso_sapper, torso_mortar, torso_grenadier, torso_jumper,
    arm_striker, arm_medic, arm_heavy, arm_flamer, arm_jumper,
    leg_engineer, leg_jumper, leg_heavy, leg_scout,
    cape_sniper, antenna_droneop, hose_flamer, sheath_striker, pauldron_heavy, ammobox_heavy,
    stretcher_medic, toolroll_engineer, detonator_sapper, mines_sapper, bipod_mortar, drums_grenadier,
    weapon_smg,
]
