import { describe, expect, it } from "vitest";
import { attackPose, throwArmAngle, weaponFamily, WEAPON_FAMILIES, type WeaponFamily } from "./worldRenderer";

// Attack choreography is pure maths over a phase, so it can be checked without a renderer at all.
// That matters because the alternative is judging it by eye on a moving target, which is how the
// walk cycle stayed broken for two commits.
// Every family, from the renderer's own list (a hand-kept copy here skipped shotgun and pistol).
const FAMILIES: readonly WeaponFamily[] = WEAPON_FAMILIES;

const sample = (family: WeaponFamily, steps = 60) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ t: i / steps, pose: attackPose(family, i / steps) }));

describe("attack choreography", () => {
  it("gives every weapon its own family", () => {
    expect(weaponFamily("striker")).toBe("melee");
    expect(weaponFamily("heavy")).toBe("burst");
    expect(weaponFamily("sniper")).toBe("marksman");
    expect(weaponFamily("mortar")).toBe("launcher");
    expect(weaponFamily("flamer")).toBe("flamer");
    expect(weaponFamily("tank")).toBe("cannon");
    expect(weaponFamily("soldier")).toBe("rifle");
  });

  for (const family of FAMILIES) {
    describe(family, () => {
      it("starts and ends at rest", () => {
        // A pose that does not return to zero leaves the weapon permanently displaced after the
        // first shot of the battle -- the kind of drift that only shows up after several turns.
        const start = attackPose(family, 0);
        const end = attackPose(family, 1);
        for (const key of ["draw", "lift", "brace"] as const) {
          expect(Math.abs(start[key]), `${family} ${key} at rest`).toBeLessThan(1e-6);
          expect(Math.abs(end[key]), `${family} ${key} after the shot`).toBeLessThan(1e-6);
        }
      });

      it("winds up before it fires", () => {
        // THE thing that separates a shot from a twitch: the weapon has to move BEFORE the round
        // leaves. Without anticipation the player sees the result before any cause.
        const early = sample(family).filter((s) => s.t > 0 && s.t < 0.3);
        const moved = early.some((s) => Math.abs(s.pose.draw) + Math.abs(s.pose.lift) + Math.abs(s.pose.brace) > 0.004);
        expect(moved, `${family} does not move before contact`).toBe(true);
      });

      it("reverses direction after contact", () => {
        // Follow-through: the weapon must come back through rest rather than easing to it from the
        // same side, or the motion reads as one slow drift instead of a strike.
        const draws = sample(family).map((s) => s.pose.draw);
        const peak = Math.max(...draws);
        const trough = Math.min(...draws);
        expect(peak, `${family} never draws back`).toBeGreaterThan(0.004);
        expect(trough, `${family} never follows through`).toBeLessThan(0);
      });

      it("stays inside a sane range", () => {
        // A pose is an offset on a model roughly 1.7 units tall; anything beyond this is a part
        // detaching from the unit rather than animating.
        for (const { pose } of sample(family)) {
          expect(Math.abs(pose.draw)).toBeLessThan(0.6);
          expect(Math.abs(pose.lift)).toBeLessThan(1.0);
          expect(Math.abs(pose.brace)).toBeLessThan(0.6);
        }
      });

      it("is continuous — no jumps between frames", () => {
        // A discontinuity is a visible pop. Sampled far finer than any real frame rate.
        const fine = sample(family, 400);
        for (let i = 1; i < fine.length; i += 1) {
          const d = Math.abs(fine[i].pose.draw - fine[i - 1].pose.draw)
            + Math.abs(fine[i].pose.lift - fine[i - 1].pose.lift);
          expect(d, `${family} jumps at t=${fine[i].t.toFixed(3)}`).toBeLessThan(0.05);
        }
      });
    });
  }

  it("clamps phases outside 0..1 instead of extrapolating", () => {
    for (const family of FAMILIES) {
      expect(attackPose(family, -3)).toEqual(attackPose(family, 0));
      expect(attackPose(family, 9)).toEqual(attackPose(family, 1));
    }
  });

  it("makes a melee swing far bigger than a marksman's settle", () => {
    // The families have to actually differ, or this is one animation wearing seven names.
    const reach = (f: WeaponFamily) => Math.max(...sample(f).map((s) => Math.abs(s.pose.draw) + Math.abs(s.pose.lift)));
    expect(reach("melee")).toBeGreaterThan(reach("marksman") * 4);
    expect(reach("launcher")).toBeGreaterThan(reach("rifle"));
  });

  it("throws a hand grenade with one overhand windmill of the free arm", () => {
    // The arm starts and ends hanging at rest (a full turn is the same pose), passes up behind the
    // head during the wind-up, and releases forward ABOVE the shoulder at contact (the sim spawns
    // the grenade at 0.58s of a 1.15s order), never jumping between frames.
    const rest = (a: number) => Math.hypot(Math.cos(a) - 1, Math.sin(a));
    expect(rest(throwArmAngle(0))).toBeLessThan(1e-6);
    expect(rest(throwArmAngle(1))).toBeLessThan(1e-6);
    const windUp = throwArmAngle(0.42);
    expect(Math.sin(windUp), "wound up BEHIND the body (hand z < shoulder)").toBeLessThan(0);
    const release = throwArmAngle(0.5);
    expect(-Math.cos(release), "released with the hand above the shoulder").toBeGreaterThan(0.5);
    expect(Math.sin(release), "released IN FRONT of the body").toBeGreaterThan(0);
    for (let i = 1; i <= 400; i += 1) {
      expect(Math.abs(throwArmAngle(i / 400) - throwArmAngle((i - 1) / 400)), `pop at ${i / 400}`).toBeLessThan(0.08);
    }
  });
});
