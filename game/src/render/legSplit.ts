import * as THREE from "three";

/**
 * Split a unit-cube leg geometry into a thigh and a shin at the knee, at load time.
 *
 * The authored leg (`art/infantry/author_kinds.py::body_leg` and the per-kind variants) is ONE
 * mesh: thigh, knee, shin and cuff joined, because that is what the kit contract wants -- one
 * `KitPart` per rig slot, normalised to a unit cube. A knee needs two rigid pieces, and the rig
 * law says a trooper is a bag of separate part meshes posed from pivots, so the split happens here
 * rather than by re-authoring five leg kits: every triangle is clipped against the knee plane,
 * both halves overrun the plane by `overlap` (so the joint never shows daylight when it bends) and
 * each open cut is capped with a fan. Attributes (position / normal / uv / COLOR_0 vertex AO) are
 * interpolated across the cut, so the pooled part material paints the halves like any other part.
 *
 * Results are cached per source geometry and flagged `userData.shared`, exactly like the source.
 */
const cache = new WeakMap<THREE.BufferGeometry, { upper: THREE.BufferGeometry; lower: THREE.BufferGeometry }>();

export function splitAtKnee(source: THREE.BufferGeometry, kneeY: number, overlap: number): { upper: THREE.BufferGeometry; lower: THREE.BufferGeometry } {
  const hit = cache.get(source);
  if (hit) return hit;
  const geo = source.index ? source.toNonIndexed() : source;
  const upper = clipHalfSpace(geo, kneeY - overlap, true);
  const lower = clipHalfSpace(geo, kneeY + overlap, false);
  upper.userData.shared = true;
  lower.userData.shared = true;
  const out = { upper, lower };
  cache.set(source, out);
  return out;
}

type Attr = { name: string; size: number; attr: THREE.BufferAttribute };

/** Keep the part of `geo` with y >= plane (`keepAbove`) or y <= plane, and cap the cut. */
function clipHalfSpace(geo: THREE.BufferGeometry, plane: number, keepAbove: boolean): THREE.BufferGeometry {
  const attrs: Attr[] = [];
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.getAttribute(name) as THREE.BufferAttribute;
    attrs.push({ name, size: a.itemSize, attr: a });
  }
  const pos = attrs.find((a) => a.name === "position");
  if (!pos) return geo.clone();
  const out: number[][] = attrs.map(() => []);
  const cutEdges: number[][] = []; // pairs of interpolated vertex records on the plane (all attrs)
  const stride = attrs.map((a) => a.size);
  const count = pos.attr.count;

  // Vertex record = every attribute's values in one flat array, so interpolation is generic.
  const record = (i: number): number[] => {
    const r: number[] = [];
    // getComponent honours `normalized` (glTF COLOR_0 ships as normalised Uint8/Uint16 -- copying
    // the raw integers painted the legs as a white-hot glow ball).
    for (const a of attrs) for (let k = 0; k < a.size; k += 1) r.push(a.attr.getComponent(i, k));
    return r;
  };
  const yOf = (r: number[]): number => r[1];
  const inside = (r: number[]): boolean => (keepAbove ? yOf(r) >= plane : yOf(r) <= plane);
  const lerpRec = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + (b[i] - v) * t);
  const emit = (r: number[]): void => {
    let o = 0;
    for (let a = 0; a < attrs.length; a += 1) {
      for (let k = 0; k < stride[a]; k += 1) out[a].push(r[o + k]);
      o += stride[a];
    }
  };

  for (let t = 0; t < count; t += 3) {
    const tri = [record(t), record(t + 1), record(t + 2)];
    // Sutherland-Hodgman against one plane: a polygon of 0, 3 or 4 vertices.
    const poly: number[][] = [];
    const cut: number[][] = [];
    for (let i = 0; i < 3; i += 1) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) poly.push(a);
      if (ia !== ib) {
        const tt = (plane - yOf(a)) / (yOf(b) - yOf(a));
        const p = lerpRec(a, b, tt);
        poly.push(p);
        cut.push(p);
      }
    }
    if (poly.length < 3) continue;
    for (let i = 1; i + 1 < poly.length; i += 1) { emit(poly[0]); emit(poly[i]); emit(poly[i + 1]); }
    if (cut.length === 2) cutEdges.push(cut[0], cut[1]);
  }

  // Cap: a fan from the centroid of the cut loop. The leg's knee section is convex enough for it.
  if (cutEdges.length >= 6) {
    const centre = cutEdges[0].map((_, k) => cutEdges.reduce((s, r) => s + r[k], 0) / cutEdges.length);
    const posOff = attrs.slice(0, attrs.indexOf(pos)).reduce((s, a) => s + a.size, 0);
    const normalIdx = attrs.findIndex((a) => a.name === "normal");
    const normalOff = attrs.slice(0, normalIdx).reduce((s, a) => s + a.size, 0);
    const ny = keepAbove ? -1 : 1;
    const withNormal = (r: number[]): number[] => {
      const c = r.slice();
      if (normalIdx >= 0) { c[normalOff] = 0; c[normalOff + 1] = ny; c[normalOff + 2] = 0; }
      return c;
    };
    const cx = centre[posOff];
    const cz = centre[posOff + 2];
    for (let i = 0; i < cutEdges.length; i += 2) {
      const a = cutEdges[i];
      const b = cutEdges[i + 1];
      // Wind the cap to face outward (down for the upper piece, up for the lower).
      const ax = a[posOff] - cx, az = a[posOff + 2] - cz;
      const bx = b[posOff] - cx, bz = b[posOff + 2] - cz;
      const cross = ax * bz - az * bx;
      const ccw = keepAbove ? cross > 0 : cross < 0;
      emit(withNormal(centre));
      emit(withNormal(ccw ? a : b));
      emit(withNormal(ccw ? b : a));
    }
  }

  const result = new THREE.BufferGeometry();
  attrs.forEach((a, i) => result.setAttribute(a.name, new THREE.Float32BufferAttribute(out[i], a.size)));
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}
