"""FACTION DRESS (2026-09-24, visual polish round). The faction silhouette pieces that were bare
boxes in `factionInfantryDress`, authored: the Syndicate's peaked hood and ragged duster, Bastion's
riveted bucket helm, layered pauldron and bossed tower shield, and the Vanguard jet pack.
Same contract as author_kinds.py: unit cube, origin-centred, X across, Y forward, Z up; the TS box
that used to be the piece gives the size, so shape lives here and proportion stays in TS.
"""
import math

from author_kit import add_box, finish, join, taper
from author_kinds import add_cone, add_cyl, rot


def dress_hood():
    hood = add_cone("hood", 0.5, 1.0, vertices=12)
    for v in hood.data.vertices:  # the peak droops back
        v.co.y -= max(0.0, v.co.z) * 0.3
    cowl = add_cyl("cowl", 0.52, 0.16, location=(0, 0, -0.44), vertices=12)
    folds = [rot(add_box(f"fold{k}", (0.06, 0.08, 0.6), location=(-0.2 + k * 0.2, -0.36, -0.12)), x=-20) for k in range(3)]
    obj = join([hood, cowl, *folds], "dress-hood")
    finish(obj, bevel=0.01, shade_smooth=False)
    return obj


def dress_duster():
    panel = add_box("panel", (0.78, 0.06, 1.0), location=(0, 0, 0.04))
    folds = [add_box(f"fold{k}", (0.07, 0.1, 0.96), location=(-0.3 + k * 0.2, -0.03, 0.04)) for k in range(4)]
    hem = [rot(add_box(f"tail{k}", (0.16, 0.05, 0.22), location=(-0.28 + k * 0.19, 0, -0.52)), y=(-1) ** k * 18) for k in range(4)]
    collar = add_box("collar", (0.82, 0.12, 0.12), location=(0, 0.02, 0.52))
    obj = join([panel, *folds, *hem, collar], "dress-duster")
    finish(obj, bevel=0.008, shade_smooth=False)
    return obj


def dress_bucket():
    bucket = add_cyl("bucket", 0.5, 0.86, vertices=14)
    taper(bucket, 0.92)
    lid = add_cyl("lid", 0.53, 0.1, location=(0, 0, 0.46), vertices=14)
    brow = add_box("brow", (0.84, 0.14, 0.12), location=(0, 0.44, 0.14))
    grille = [add_box(f"vent{k}", (0.07, 0.08, 0.26), location=(-0.18 + k * 0.12, 0.47, -0.2)) for k in range(4)]
    rivets = [add_box(f"rv{k}", (0.07, 0.07, 0.07), location=(math.cos(a) * 0.5, math.sin(a) * 0.5, 0.32)) for k, a in enumerate(i * math.tau / 10 for i in range(10))]
    obj = join([bucket, lid, brow, *grille, *rivets], "dress-bucket")
    finish(obj, bevel=0.01, shade_smooth=False)
    return obj


def dress_pauldron():
    plates = [rot(add_box(f"plate{k}", (0.9 - k * 0.12, 1.0 - k * 0.1, 0.2), location=(0, 0, 0.3 - k * 0.24)), y=0) for k in range(3)]
    for k, p in enumerate(plates):
        taper(p, 0.8)
    ridge = add_box("ridge", (0.1, 1.0, 0.12), location=(0, 0, 0.46))
    rivets = [add_box(f"rv{k}", (0.08, 0.08, 0.06), location=(s * 0.36, y, 0.44)) for k, (s, y) in enumerate(((-1, -0.36), (1, -0.36), (-1, 0.36), (1, 0.36)))]
    obj = join([*plates, ridge, *rivets], "dress-pauldron")
    finish(obj, bevel=0.01, shade_smooth=False)
    return obj


def dress_shield():
    faces = [rot(add_box(f"face{k}", (0.34, 0.1, 1.0), location=(k * 0.32, -abs(k) * 0.05, 0)), z=-k * 12) for k in (-1, 0, 1)]
    rim = [add_box(f"rim{s}", (1.02, 0.14, 0.08), location=(0, 0.02, s * 0.5)) for s in (-1, 1)]
    boss = add_cyl("boss", 0.16, 0.14, location=(0, 0.08, 0.1), rotation=(math.radians(90), 0, 0), vertices=12)
    bands = [add_box(f"band{s}", (1.0, 0.12, 0.06), location=(0, 0.02, s * 0.25)) for s in (-1, 1)]
    obj = join([*faces, *rim, boss, *bands], "dress-shield")
    finish(obj, bevel=0.01, shade_smooth=False)
    return obj


def dress_jetpack():
    body = add_box("body", (0.8, 0.5, 1.0), location=(0, 0, 0))
    taper(body, 0.86)
    tanks = [add_cyl(f"tank{s}", 0.2, 0.9, location=(s * 0.3, -0.28, 0.02), vertices=12) for s in (-1, 1)]
    caps = [add_cyl(f"cap{s}", 0.14, 0.1, location=(s * 0.3, -0.28, 0.5), vertices=12) for s in (-1, 1)]
    vents = [add_box(f"vent{k}", (0.5, 0.08, 0.05), location=(0, -0.26, -0.2 + k * 0.1)) for k in range(3)]
    spine = add_box("spine", (0.12, 0.1, 1.04), location=(0, -0.3, 0))
    obj = join([body, *tanks, *caps, *vents, spine], "dress-jetpack")
    finish(obj, bevel=0.01, shade_smooth=False)
    return obj


DRESS_BUILDERS = [dress_hood, dress_duster, dress_bucket, dress_pauldron, dress_shield, dress_jetpack]
