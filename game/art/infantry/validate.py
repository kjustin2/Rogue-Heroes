# =============================================================================
#  KIT VALIDATOR — the QA gate at the end of `npm run art:kit` (and `art:props`).
# -----------------------------------------------------------------------------
#  A regenerated kit must not ship a bad part silently: the game falls back to a
#  procedural box for anything missing and repaints every part per frame, so a
#  flipped shell, a wire edge or a renamed part would only show up as "that helmet
#  looks wrong" three rounds later. Every rule here is a measurement on the mesh:
#
#    - geometry: no loose verts/edges, no edge shared by 3+ faces, no zero-area
#      faces, no NaN coordinates. Kitbashed parts are JOINED shells (not booleaned)
#      and helmets are cut open at the rim, so open boundary edges are REPORTED,
#      never failed — "manifold" here means "nothing that renders wrong".
#    - orientation: every connected shell faces outward on average (a flipped
#      shell is a black hole under the toon ramp).
#    - budget: triangles per part under a cap (the whole roster renders these
#      thousands of times; one 20k-tri helmet would be the entire budget).
#    - contract: bbox is exactly the unit cube centred on the origin, the part has
#      UVs and the baked COLOR_0 attribute, and the set of part NAMES equals the
#      `KitPart` union in src/render/models.ts — a part the game never asks for is
#      dead weight; a part the game asks for and cannot find is a silent box.
#
#  validate_scene(names) raises ValidationError on any failure; author_kit.py calls
#  sys.exit(1) on it so blender.mjs / npm see a non-zero status.
# =============================================================================
import os
import re
from collections import defaultdict

import bmesh
import bpy
from mathutils import Vector

MODELS_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "render", "models.ts")
TRI_BUDGET = 2400
BBOX_TOL = 2e-3


class ValidationError(Exception):
    pass


def kit_part_names(union_name="KitPart"):
    """The string-literal members of a TS union type in models.ts, e.g. `export type KitPart = "a" | "b";`."""
    with open(MODELS_TS, encoding="utf-8") as fh:
        src = fh.read()
    m = re.search(r"export type %s\s*=\s*(.*?);" % re.escape(union_name), src, re.S)
    if not m:
        raise ValidationError(f"could not find `export type {union_name}` in {MODELS_TS}")
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def _component_orientation(bm):
    """For each connected shell: mean of (face normal . (face centre - shell centroid)). Negative
    means the shell faces inward."""
    seen = set()
    results = []
    for start in bm.faces:
        if start.index in seen:
            continue
        stack, faces = [start], []
        seen.add(start.index)
        while stack:
            f = stack.pop()
            faces.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        centroid = Vector((0, 0, 0))
        for f in faces:
            centroid += f.calc_center_median()
        centroid /= len(faces)
        score = 0.0
        for f in faces:
            d = f.calc_center_median() - centroid
            if d.length > 1e-6:
                score += f.normal.dot(d.normalized()) * f.calc_area()
        results.append((len(faces), score))
    return results


def validate_object(obj, require_color=True, tri_budget=TRI_BUDGET):
    """Returns a list of failure strings (empty = pass) and a dict of informational counts."""
    fails = []
    info = {}
    mesh = obj.data
    if obj.type != "MESH":
        return [f"{obj.name}: not a mesh"], info
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    bm.normal_update()

    tris = sum(len(f.verts) - 2 for f in bm.faces)
    info["tris"] = tris
    if tris == 0:
        fails.append(f"{obj.name}: no faces")
    if tris > tri_budget:
        fails.append(f"{obj.name}: {tris} tris over the {tri_budget} budget")

    for v in bm.verts:
        if any(c != c for c in v.co):
            fails.append(f"{obj.name}: NaN vertex")
            break
    loose_v = sum(1 for v in bm.verts if not v.link_edges)
    loose_e = sum(1 for e in bm.edges if not e.link_faces)
    over = sum(1 for e in bm.edges if len(e.link_faces) > 2)
    boundary = sum(1 for e in bm.edges if len(e.link_faces) == 1)
    zero = sum(1 for f in bm.faces if f.calc_area() < 1e-9)
    info.update(loose_verts=loose_v, loose_edges=loose_e, boundary_edges=boundary, overshared_edges=over, zero_area=zero)
    if loose_v:
        fails.append(f"{obj.name}: {loose_v} loose vertices")
    if loose_e:
        fails.append(f"{obj.name}: {loose_e} wire edges")
    if over:
        fails.append(f"{obj.name}: {over} edges shared by 3+ faces")
    if zero:
        fails.append(f"{obj.name}: {zero} zero-area faces")

    flipped = [(n, s) for n, s in _component_orientation(bm) if s < 0 and n >= 4]
    if flipped:
        fails.append(f"{obj.name}: {len(flipped)} inward-facing shell(s) ({', '.join(str(n) + ' faces' for n, _ in flipped)})")
    bm.free()

    # Contract: unit cube centred on the origin, in the mesh's own coordinates (transforms applied).
    if any(abs(s - 1.0) > 1e-6 for s in obj.scale) or any(abs(r) > 1e-6 for r in obj.rotation_euler) or obj.location.length > 1e-6:
        fails.append(f"{obj.name}: object transform not applied")
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    if mesh.vertices:
        for axis, vals in (("x", xs), ("y", ys), ("z", zs)):
            lo, hi = min(vals), max(vals)
            if abs(lo + 0.5) > BBOX_TOL or abs(hi - 0.5) > BBOX_TOL:
                fails.append(f"{obj.name}: bbox {axis} is [{lo:.3f}, {hi:.3f}], expected [-0.5, 0.5]")
    if not mesh.uv_layers:
        fails.append(f"{obj.name}: no UV layer (the shared detail normal map needs one)")
    if require_color and not mesh.color_attributes:
        fails.append(f"{obj.name}: no colour attribute (vertex AO missing — would sample BLACK)")
    return fails, info


def validate_scene(expected_names, require_color=True, tri_budget=TRI_BUDGET, label="kit"):
    objs = [o for o in bpy.data.objects if o.type == "MESH"]
    names = [o.name for o in objs]
    fails = []
    dupes = [n for n, c in defaultdict(int, {n: names.count(n) for n in names}).items() if c > 1]
    if dupes:
        fails.append(f"duplicate part names: {sorted(dupes)}")
    present = set(names)
    missing = sorted(expected_names - present)
    extra = sorted(present - expected_names)
    if missing:
        fails.append(f"parts the game asks for but the {label} does not build: {missing}")
    if extra:
        fails.append(f"parts built but never referenced by the game: {extra}")
    total = 0
    for o in objs:
        f, info = validate_object(o, require_color=require_color, tri_budget=tri_budget)
        fails.extend(f)
        total += info.get("tris", 0)
        print(f"[validate] {o.name:<24} {info.get('tris', 0):>6} tris  open-edges {info.get('boundary_edges', 0):<4}")
    print(f"[validate] {len(objs)} parts, {total} tris total")
    if fails:
        for f in fails:
            print("[validate] FAIL", f)
        raise ValidationError(f"{len(fails)} {label} validation failure(s)")
    print(f"[validate] {label} OK")
