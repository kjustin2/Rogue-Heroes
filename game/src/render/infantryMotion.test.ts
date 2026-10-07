import { describe, expect, it } from "vitest";
import { INFANTRY_MOTION, MOTION_CHANNELS } from "../game/infantryMotionData";
import { hasMotionBank, motionContact, sampleMotion } from "./infantryMotion";
import { WEAPON_FAMILIES, type WeaponFamily } from "./worldRenderer";

// The Blender bank is GENERATED, so these guard the pipeline rather than the numbers: that the
// export produced well-formed data, that the sampler reads it correctly, and that the properties
// the animation depends on actually hold. A broken export would otherwise show up as units posing
// strangely in play, which is the hardest kind of bug to notice.
// Every family with a Blender bank: all of them except the throw, which is a procedural windmill of
// the free arm (throwArmAngle) that no rifle clip describes.
const FAMILIES: readonly WeaponFamily[] = WEAPON_FAMILIES.filter((f) => f !== "throw");

describe("infantry motion banks", () => {
  it("exported every clip at a uniform length and width", () => {
    const names = Object.keys(INFANTRY_MOTION);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const clip = INFANTRY_MOTION[name];
      expect(clip.frames.length, `${name} frame count`).toBe(101);
      for (const frame of clip.frames) {
        expect(frame.length, `${name} channel count`).toBe(MOTION_CHANNELS.length);
        for (const value of frame) expect(Number.isFinite(value), `${name} has a non-finite sample`).toBe(true);
      }
    }
  });

  it("starts and ends every clip at rest", () => {
    // A clip that does not return to zero leaves the trooper permanently displaced after its first
    // shot of the battle -- drift that only becomes visible several turns in.
    for (const name of Object.keys(INFANTRY_MOTION)) {
      const clip = INFANTRY_MOTION[name];
      for (const frame of [clip.frames[0], clip.frames[clip.frames.length - 1]]) {
        for (let i = 0; i < frame.length; i += 1) {
          expect(Math.abs(frame[i]), `${name} ${MOTION_CHANNELS[i]} at rest`).toBeLessThan(0.02);
        }
      }
    }
  });

  it("actually moves between the ends", () => {
    // Guards the export silently producing a bank of zeroes, which would typecheck, pass every
    // other assertion here, and render as a unit that never animates.
    for (const name of Object.keys(INFANTRY_MOTION)) {
      const clip = INFANTRY_MOTION[name];
      const peak = Math.max(...clip.frames.flat().map(Math.abs));
      expect(peak, `${name} is a flat bank`).toBeGreaterThan(0.05);
    }
  });

  it("puts a clip behind every weapon family", () => {
    for (const family of FAMILIES) {
      expect(hasMotionBank(family), `${family} has no bank`).toBe(true);
      expect(motionContact(family)).toBeGreaterThan(0);
      expect(motionContact(family)).toBeLessThan(1);
    }
  });

  it("interpolates between frames rather than snapping", () => {
    // Halfway between two samples should land between them, not on one of them.
    const clip = INFANTRY_MOTION.melee;
    const a = clip.frames[40][0];
    const b = clip.frames[41][0];
    const mid = sampleMotion("melee", 40.5 / 100).shoulderPitch;
    if (Math.abs(a - b) > 1e-6) {
      expect(mid).toBeGreaterThan(Math.min(a, b) - 1e-6);
      expect(mid).toBeLessThan(Math.max(a, b) + 1e-6);
      expect(mid).not.toBeCloseTo(a, 9);
    }
  });

  it("clamps out-of-range phases instead of extrapolating", () => {
    for (const family of FAMILIES) {
      const low = { ...sampleMotion(family, -2) };
      const zero = { ...sampleMotion(family, 0) };
      const high = { ...sampleMotion(family, 5) };
      const one = { ...sampleMotion(family, 1) };
      expect(low).toEqual(zero);
      expect(high).toEqual(one);
    }
  });

  it("is continuous across the whole clip", () => {
    // A discontinuity is a visible pop on a unit mid-attack. Sampled far finer than any frame rate.
    for (const family of FAMILIES) {
      let previous = sampleMotion(family, 0).shoulderPitch;
      for (let i = 1; i <= 500; i += 1) {
        const value = sampleMotion(family, i / 500).shoulderPitch;
        expect(Math.abs(value - previous), `${family} jumps at ${i / 500}`).toBeLessThan(0.06);
        previous = value;
      }
    }
  });

  it("gives melee a far bigger swing than a marksman's settle", () => {
    const reach = (family: WeaponFamily) => {
      let peak = 0;
      for (let i = 0; i <= 100; i += 1) {
        const p = sampleMotion(family, i / 100);
        peak = Math.max(peak, Math.abs(p.shoulderPitch) + Math.abs(p.torsoTwist));
      }
      return peak;
    };
    expect(reach("melee")).toBeGreaterThan(reach("marksman") * 4);
  });
});
