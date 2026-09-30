"""HERO PROPS (2026-09-24, overhaul option 7). The biome props that were box-built in TS
(`buildBiomeProp`), re-authored as one shaped body each: a real I-beam, a wound coil, angle-iron
hedgehog, a planked boat hull, a tapered obelisk, amphorae, heaved ice, round bales, headstones.
The body is ONE pooled toon part (one colour); the accents that carry a second colour -- the
hazard foot, the coil eye, the gilded cap, the strake -- stay small TS accent meshes, so the mesh
leaves those volumes out (no coplanar faces to fight). Blender z is up; everything is normalised to
the unit cube by `flat()`, and `buildBiomeProp` scales it back to the size it gives.
"""
import math
import random

import bpy

import author_kit
from author_kit import join


class _Props:
    """author_props, imported on first use: it is running as __main__ and imports this module, so a
    top-level import would be circular (author_landmarks imports it inside its functions for the same reason)."""

    def __getattr__(self, name):
        import author_props
        return getattr(author_props, name)


P = _Props()


def _rng(kind, i):
    return random.Random(f"hero-{kind}-{i}")


def box(name, size, loc, rot=(0.0, 0.0, 0.0)):
    """A box with its size, rotation AND location baked into the mesh (join keeps the first origin)."""
    obj = author_kit.add_box(name, size, location=loc)
    obj.rotation_euler = rot
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def cyl(name, r, depth, loc, rot=(0.0, 0.0, 0.0), vertices=12, r_top=None):
    return P.cyl(name, r, depth, location=loc, rotation=rot, vertices=vertices, radius_top=r_top)


def build_girder(i):
    parts = [box("plate", (1.0, 1.0, 0.12), (0, 0, 0.06))]
    parts += [box(f"flange{s}", (0.5, 0.06, 2.4), (0, s * 0.19, 1.32)) for s in (-1, 1)]
    parts.append(box("web", (0.06, 0.38, 2.4), (0, 0, 1.32)))
    parts += [box(f"gusset{s}", (0.34, 0.05, 0.34), (s * 0.18, 0, 0.3), (0, s * 0.785, 0)) for s in (-1, 1)]
    parts += [box(f"rivet{k}", (0.07, 0.08, 0.07), (0.16 * (1 if k % 2 else -1), 0.23, 0.7 + k * 0.32)) for k in range(5)]
    parts.append(box("cap", (0.64, 0.56, 0.1), (0, 0, 2.56)))
    parts.append(box("brace", (0.12, 0.12, 1.0), (0.36, 0, 2.0), (0, -0.62, 0)))
    obj = join(parts, f"girder-{i}")
    P.flat(obj, bevel=0.012)
    return obj


def build_coil(i):
    parts = [box(f"cradle{s}", (0.22, 1.2, 0.24), (s * 0.42, 0, 0.12)) for s in (-1, 1)]
    parts.append(cyl("coil", 0.52, 0.96, (0, 0, 0.62), (math.radians(90), 0, 0), vertices=12))
    parts += [cyl(f"wrap{k}", 0.535, 0.03, (0, -0.3 + k * 0.3, 0.62), (math.radians(90), 0, 0), vertices=12) for k in range(3)]
    parts += [cyl(f"strap{s}", 0.55, 0.06, (s * 0.2, 0, 0.62), (0, math.radians(90), 0), vertices=12) for s in (-1, 1)]
    obj = join(parts, f"coil-{i}")
    P.floor(obj, 0.0)
    P.flat(obj, bevel=0.008)
    return obj


def build_hedgehog(i):
    parts = []
    for k in range(3):
        for j, size in enumerate(((0.22, 0.05, 1.7), (0.05, 0.22, 1.7))):  # an L-angle: two plates
            off = (0.085, 0, 0) if j == 1 else (0, 0.085, 0)
            b = box(f"a{k}{j}", size, off)
            b.rotation_euler = (0.86, 0, k * math.tau / 3)
            bpy.ops.object.transform_apply(rotation=True)
            parts.append(b)
    parts.append(box("gusset", (0.34, 0.34, 0.34), (0, 0, 0)))
    obj = join(parts, f"hedgehog-{i}")
    for v in obj.data.vertices:
        v.co.z += 0.55
    P.floor(obj, 0.0)
    P.flat(obj, bevel=0.01)
    return obj


def build_boat(i):
    # Keel-up hull above the pale strake (the strake, keel and chocks are TS accents).
    parts = [box("hull", (1.7, 1.02, 0.34), (-0.2, 0, 0.53))]
    bow = box("bow", (0.74, 0.74, 0.34), (0.62, 0, 0.53), (0, 0, math.radians(45)))
    author_kit.taper(bow, 0.7)
    parts.append(bow)
    parts.append(box("transom", (0.08, 1.06, 0.4), (-1.06, 0, 0.52)))
    parts += [box(f"plank{k}", (1.74, 0.04, 0.05), (-0.2, s * (0.35 + k * 0.12), 0.7 - k * 0.1)) for k in range(2) for s in (-1, 1)]
    parts += [box(f"rib{k}", (0.05, 1.06, 0.36), (-0.9 + k * 0.4, 0, 0.53)) for k in range(4)]
    obj = join(parts, f"boat-{i}")
    P.flat(obj, bevel=0.01)
    return obj


def build_obelisk(i):
    parts = [box("plinth", (1.12, 1.12, 0.32), (0, 0, 0.16)), box("step", (0.84, 0.84, 0.14), (0, 0, 0.39))]
    shaft = box("shaft", (0.64, 0.64, 2.2), (0, 0, 1.56))
    author_kit.taper(shaft, 0.7)
    parts.append(shaft)
    parts += [box(f"band{k}", (0.66 - k * 0.07, 0.66 - k * 0.07, 0.08), (0, 0, 1.1 + k * 0.62)) for k in range(3)]
    parts += [box(f"glyph{k}", (0.12, 0.04, 0.16), (-0.12 + (k % 2) * 0.24, 0.33 - k * 0.004, 0.8 + (k // 2) * 0.3)) for k in range(4)]
    pyr = cyl("pyramidion", 0.33, 0.36, (0, 0, 2.84), (0, 0, math.radians(45)), vertices=4, r_top=0.02)
    parts.append(pyr)
    obj = join(parts, f"obelisk-{i}")
    P.flat(obj, bevel=0.01)
    return obj


def _amphora(name, x, y, r, lying=False):
    belly = P.ico(f"{name}b", radius=r, subdiv=1, location=(0, 0, r * 1.3), scale=(1, 1, 1.3))
    shoulder = cyl(f"{name}s", r * 0.42, r * 0.5, (0, 0, r * 2.5), r_top=r * 0.3)
    neck = cyl(f"{name}n", r * 0.3, r * 0.6, (0, 0, r * 2.9))
    lip = cyl(f"{name}l", r * 0.42, r * 0.12, (0, 0, r * 3.24))
    foot = cyl(f"{name}f", r * 0.28, r * 0.2, (0, 0, r * 0.1), r_top=r * 0.4)
    handles = [box(f"{name}h{s}", (r * 0.12, r * 0.12, r * 0.9), (s * r * 0.62, 0, r * 2.55), (0, s * 0.5, 0)) for s in (-1, 1)]
    obj = join([belly, shoulder, neck, lip, foot, *handles], name)
    if lying:
        for v in obj.data.vertices:
            v.co.x, v.co.z = v.co.z - r * 1.6, -v.co.x + r * 0.95  # a 90-degree turn about y (a swap would mirror it inside out)
    for v in obj.data.vertices:
        v.co.x += x
        v.co.y += y
    return obj


def build_urn(i):
    jars = [_amphora("j0", -0.14, -0.1, 0.3), _amphora("j1", 0.38, 0.22, 0.24), _amphora("j2", -0.2, 0.46, 0.22, lying=True)]
    obj = join(jars, f"urn-{i}")
    P.floor(obj, 0.0)
    P.flat(obj)
    return obj


def build_iceblock(i):
    rng = _rng("ice", i)
    parts = [box("floe", (1.5, 1.2, 0.5), (0, 0, 0.2), (rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), rng.uniform(0, 1)))]
    for k in range(3 + i):
        a = rng.uniform(0, math.tau)
        parts.append(box(f"shard{k}", (rng.uniform(0.6, 1.1), rng.uniform(0.24, 0.36), rng.uniform(0.7, 1.2)),
                         (math.cos(a) * 0.3, math.sin(a) * 0.3, 0.5), (rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6), a)))
    obj = join(parts, f"iceblock-{i}")
    P.displace(obj, rng, amount=0.04, scale=3.0)
    P.floor(obj, 0.0)
    P.flat(obj)
    return obj


def build_haybale(i):
    stand = cyl("stand", 0.42, 0.84, (-0.48, 0.05, 0.42), vertices=12)
    rings = [cyl(f"ring{k}", 0.42 - k * 0.1, 0.02, (-0.48, 0.05, 0.85 + k * 0.004), vertices=12) for k in range(3)]
    lie = cyl("lie", 0.38, 0.76, (0.42, -0.05, 0.38), (math.radians(90), 0, 0), vertices=12)
    bands = [cyl(f"band{s}", 0.4, 0.05, (0.42, -0.05 + s * 0.2, 0.38), (math.radians(90), 0, 0), vertices=12) for s in (-1, 1)]
    bands += [cyl(f"sband{s}", 0.44, 0.05, (-0.48, 0.05, 0.42 + s * 0.22), vertices=12) for s in (-1, 1)]
    obj = join([stand, *rings, lie, *bands], f"haybale-{i}")
    P.floor(obj, 0.0)
    P.flat(obj, bevel=0.006)
    return obj


def build_grave(i):
    rng = _rng("grave", i)
    lean = rng.uniform(-0.12, 0.12)
    slab = box("slab", (0.5, 0.14, 0.62), (-0.3, 0.12, 0.31), (lean, 0, 0.1))
    top = cyl("top", 0.25, 0.14, (-0.3, 0.12, 0.62), (math.radians(90), 0, 0), vertices=12)
    top.rotation_euler = (lean, 0, 0.1)
    bpy.ops.object.transform_apply(rotation=True)
    post = box("post", (0.12, 0.12, 0.84), (0.38, -0.1, 0.42), (-lean, 0.08, -0.2))
    arm = box("arm", (0.46, 0.11, 0.12), (0.38, -0.1, 0.6), (-lean, 0.08, -0.2))
    ledger = box("ledger", (0.46, 0.76, 0.08), (0.02, -0.46, 0.04))
    kerb = box("kerb", (0.56, 0.86, 0.04), (0.02, -0.46, 0.02))
    obj = join([slab, top, post, arm, ledger, kerb], f"grave-{i}")
    P.displace(obj, rng, amount=0.012, scale=8.0)
    P.floor(obj, 0.0)
    P.flat(obj)
    return obj


HERO_BUILDERS = {"girder": build_girder, "coil": build_coil, "hedgehog": build_hedgehog, "boat": build_boat,
                 "obelisk": build_obelisk, "urn": build_urn, "iceblock": build_iceblock, "haybale": build_haybale,
                 "grave": build_grave}
HERO_VARIANTS = {"girder": 1, "coil": 1, "hedgehog": 1, "boat": 1, "obelisk": 1, "urn": 1, "iceblock": 2, "haybale": 1, "grave": 2}
