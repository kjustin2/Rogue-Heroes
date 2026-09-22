import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { splitAtKnee } from "./legSplit";

/** Signed volume of a closed triangle soup -- positive with outward winding, ~0 if a cap is missing or inverted. */
function signedVolume(geo: THREE.BufferGeometry): number {
  const p = geo.getAttribute("position");
  let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i);
    const bx = p.getX(i + 1), by = p.getY(i + 1), bz = p.getZ(i + 1);
    const cx = p.getX(i + 2), cy = p.getY(i + 2), cz = p.getZ(i + 2);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe("splitAtKnee", () => {
  it("cuts a unit cube into two closed, overlapping halves and keeps every attribute", () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    // A colour attribute stands in for the kit's baked AO.
    const n = box.getAttribute("position").count;
    box.setAttribute("color", new THREE.Float32BufferAttribute(new Array(n * 3).fill(0.5), 3));
    const { upper, lower } = splitAtKnee(box, -0.04, 0.05);
    for (const g of [upper, lower]) {
      expect(g.getAttribute("position")).toBeTruthy();
      expect(g.getAttribute("normal")).toBeTruthy();
      expect(g.getAttribute("uv")).toBeTruthy();
      expect(g.getAttribute("color")).toBeTruthy();
      expect(g.userData.shared).toBe(true);
    }
    upper.computeBoundingBox();
    lower.computeBoundingBox();
    expect(upper.boundingBox!.min.y).toBeCloseTo(-0.09, 5);
    expect(upper.boundingBox!.max.y).toBeCloseTo(0.5, 5);
    expect(lower.boundingBox!.min.y).toBeCloseTo(-0.5, 5);
    expect(lower.boundingBox!.max.y).toBeCloseTo(0.01, 5);
    // Closed and outward-wound: the signed volume is the slab's volume, not zero.
    expect(signedVolume(upper)).toBeCloseTo(0.59, 3);
    expect(signedVolume(lower)).toBeCloseTo(0.51, 3);
    // Cached per source.
    expect(splitAtKnee(box, -0.04, 0.05).upper).toBe(upper);
  });

  it("works on an indexed cylinder (the authored thigh/shin are capped cylinders)", () => {
    const cyl = new THREE.CylinderGeometry(0.3, 0.3, 1, 12);
    const { upper, lower } = splitAtKnee(cyl, 0, 0.05);
    const full = Math.PI * 0.3 * 0.3 * 1;
    // A 12-gon underestimates a circle; compare the halves against the whole instead.
    const whole = signedVolume(cyl.toNonIndexed());
    expect(whole).toBeGreaterThan(full * 0.9);
    expect(signedVolume(upper)).toBeCloseTo(whole * 0.55, 3);
    expect(signedVolume(lower)).toBeCloseTo(whole * 0.55, 3);
  });
});
