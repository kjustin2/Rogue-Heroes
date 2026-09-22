import { describe, expect, it } from "vitest";
import { ANKLE_Y, CROUCH_GAIT, GAIT_TIERS, HEEL, HIP_Y, HIP_Z, SHIN, THIGH, TOE, bodyAt, footAt, gaitTier, hipBob, hipCeiling, legReach, solveLeg, type GaitParams } from "./gait";

const ALL: [string, GaitParams][] = [...Object.entries(GAIT_TIERS), ["crouch", CROUCH_GAIT]];

/** The point of the sole touching the ground for a planted foot: heel while it rolls down, toe while it lifts, else the ankle's own plumb line. */
function contactPoint(f: { y: number; z: number; pitch: number }): { y: number; z: number } {
  if (f.pitch > 0) return { y: f.y - HEEL * Math.sin(f.pitch), z: f.z - HEEL * Math.cos(f.pitch) };
  if (f.pitch < 0) return { y: f.y + TOE * Math.sin(f.pitch), z: f.z + TOE * Math.cos(f.pitch) };
  return { y: f.y, z: f.z };
}

describe("infantry gait", () => {
  it("a planted foot has zero ground velocity: the contact point + distance travelled is constant through stance", () => {
    for (const [name, g] of ALL) {
      const world: number[] = [];
      for (let u = 0; u < g.stance; u += g.stance / 200) {
        const f = footAt(g, u, 0);
        expect(f.planted, `${name} u=${u}`).toBe(true);
        const c = contactPoint(f);
        expect(Math.abs(c.y - ANKLE_Y), `${name} u=${u.toFixed(3)} sole off the ground`).toBeLessThan(1e-9);
        // The body has travelled u * stride metres since contact; the world position of the point
        // of contact is its body-frame z plus that travel. Heel -> flat -> toe is a ROLL, so the
        // planted point walks forward along the sole by HEEL + TOE over the stance and nothing else.
        world.push(c.z + u * g.stride);
      }
      const drift = Math.max(...world) - Math.min(...world);
      expect(drift, `${name}: contact point drifted ${drift.toFixed(4)} m over stance`).toBeLessThan(HEEL + TOE + 1e-9);
      // ...and within each phase of the roll it is exactly pinned.
      const flat = world.filter((_, i) => { const s = i / 200; return s > 0.31 && s < 0.69; });
      expect(Math.max(...flat) - Math.min(...flat), `${name} flat-foot drift`).toBeLessThan(1e-9);
    }
  });

  it("every stance target is reachable (the hip curve never rises above the planted leg's reach)", () => {
    for (const [name, g] of ALL) {
      for (let p = 0; p < 1; p += 1 / 400) {
        const bob = hipBob(g, p);
        const hip = HIP_Y - bob;
        const ceiling = hipCeiling(g, p);
        if (ceiling !== Number.POSITIVE_INFINITY) expect(hip, `${name} p=${p.toFixed(3)} hip ${hip.toFixed(3)} above reach ${ceiling.toFixed(3)}`).toBeLessThan(ceiling - 0.002);
        for (const u of [p, p + 0.5]) {
          const f = footAt(g, u, bob);
          if (!f.planted) continue;
          const pose = solveLeg(f);
          expect(Math.abs(pose.ankleY - f.y), `${name} p=${p.toFixed(3)} ankle y`).toBeLessThan(1e-6);
          expect(Math.abs(pose.ankleZ - f.z), `${name} p=${p.toFixed(3)} ankle z`).toBeLessThan(1e-6);
          expect(pose.knee, `${name} knee`).toBeGreaterThanOrEqual(0);
          expect(pose.thigh, `${name} thigh ahead of shin`).toBeGreaterThanOrEqual(pose.shin - 1e-9);
        }
      }
    }
  });

  it("the knee visibly breaks: mid-stance and mid-swing both bend well past a straight leg", () => {
    for (const [name, g] of ALL) {
      const pMid = g.stance / 2;
      const bobMid = hipBob(g, pMid);
      expect(solveLeg(footAt(g, pMid, bobMid)).knee, `${name} mid-stance knee`).toBeGreaterThan(0.35);
      const pSwing = g.stance + (1 - g.stance) * 0.5;
      const bobSw = hipBob(g, pSwing);
      expect(solveLeg(footAt(g, pSwing, bobSw)).knee, `${name} mid-swing knee`).toBeGreaterThan(0.6);
    }
  });

  it("swing foot lifts and lands heel-first, toe-off leaves heel-up", () => {
    for (const [name, g] of ALL) {
      const mid = footAt(g, g.stance + (1 - g.stance) * 0.5, 0);
      expect(mid.planted).toBe(false);
      expect(mid.y - ANKLE_Y, `${name} lift`).toBeGreaterThan(g.lift * 0.9);
      expect(footAt(g, 0.001, 0).pitch, `${name} heel strike`).toBeGreaterThan(0.2);
      expect(footAt(g, g.stance - 0.001, 0).pitch, `${name} toe-off`).toBeLessThan(-0.35);
    }
  });

  it("the hip bobs twice per cycle, continuously, and the two legs mirror half a cycle apart", () => {
    for (const [name, g] of ALL) {
      const bobs: number[] = [];
      for (let p = 0; p < 1; p += 1 / 200) bobs.push(hipBob(g, p));
      const range = Math.max(...bobs) - Math.min(...bobs);
      expect(range, `${name} bob range`).toBeGreaterThan(0.015);
      expect(range, `${name} bob range`).toBeLessThan(0.12);
      for (let p = 0; p < 0.5; p += 0.05) expect(Math.abs(hipBob(g, p) - hipBob(g, p + 0.5))).toBeLessThan(1e-9);
      for (let i = 1; i < bobs.length; i += 1) expect(Math.abs(bobs[i] - bobs[i - 1]), `${name} bob jump at ${i}`).toBeLessThan(0.008);
      expect(Math.abs(bobs[0] - bobs[bobs.length - 1]), `${name} wrap`).toBeLessThan(0.008);
      // The swing foot's path is continuous too (no pop at toe-off or contact).
      let prev = footAt(g, 0, 0);
      for (let u = 1 / 400; u <= 1; u += 1 / 400) {
        const f = footAt(g, u, 0);
        expect(Math.hypot(f.y - prev.y, f.z - prev.z), `${name} foot jump at u=${u.toFixed(3)}`).toBeLessThan(0.02);
        prev = f;
      }
    }
  });

  it("the pelvis twists toward the leading leg and the sway is a full-cycle roll", () => {
    const g = GAIT_TIERS.walk;
    const b = bodyAt(g, 0);
    expect(b.pelvisYaw).toBeLessThan(-0.05);
    const b2 = bodyAt(g, 0.5);
    expect(b2.pelvisYaw).toBeGreaterThan(0.05);
    expect(Math.abs(b.pelvisYaw + b2.pelvisYaw)).toBeLessThan(1e-9);
    expect(Math.abs(bodyAt(GAIT_TIERS.trudge, 0.25).sway)).toBeCloseTo(GAIT_TIERS.trudge.sway, 6);
  });

  it("tiers are distinct: march strides longer and leans more, trudge is shorter, wider and rolls", () => {
    const { walk, march, trudge } = GAIT_TIERS;
    expect(march.stride).toBeGreaterThan(walk.stride);
    expect(trudge.stride).toBeLessThan(walk.stride);
    expect(march.lean).toBeGreaterThan(walk.lean);
    expect(trudge.sway).toBeGreaterThan(walk.sway * 2);
    expect(trudge.width).toBeGreaterThan(walk.width);
    expect(trudge.stance).toBeGreaterThan(march.stance);
    expect(gaitTier("scout")).toBe("march");
    expect(gaitTier("striker")).toBe("march");
    expect(gaitTier("heavy")).toBe("trudge");
    expect(gaitTier("mortar")).toBe("trudge");
    expect(gaitTier("flamer")).toBe("trudge");
    expect(gaitTier("soldier")).toBe("walk");
    // Crouched movement stays low with short steps.
    expect(CROUCH_GAIT.stride).toBeLessThan(walk.stride * 0.5);
    expect(CROUCH_GAIT.stance).toBeGreaterThan(0.5);
    expect(hipBob(CROUCH_GAIT, 0.15)).toBeGreaterThan(0.2);
  });

  it("IK is exact at full extension and the rest pose is the straight leg", () => {
    const rest = solveLeg({ y: ANKLE_Y, z: HIP_Z, pitch: 0, planted: true });
    expect(Math.abs(rest.thigh)).toBeLessThan(1e-9);
    expect(Math.abs(rest.knee)).toBeLessThan(1e-9);
    expect(legReach(0)).toBeCloseTo(THIGH + SHIN, 6);
    expect(legReach(Math.PI)).toBeCloseTo(Math.abs(THIGH - SHIN), 6);
  });
});
