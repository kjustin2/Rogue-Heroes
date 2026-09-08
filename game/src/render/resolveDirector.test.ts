import { describe, expect, it } from "vitest";
import { POI_WEIGHT, ResolveDirector } from "./resolveDirector";

// The director is pure: no THREE, no sim, no DOM. That is deliberate -- camera direction is the
// kind of thing that is otherwise only checkable by watching, and watching is exactly what nobody
// does on every commit.
const step = (d: ResolveDirector, seconds: number, dt = 1 / 60) => {
  let last = d.update(0);
  for (let t = 0; t < seconds; t += dt) last = d.update(dt);
  return last;
};

describe("resolve director", () => {
  it("points the camera at the only thing happening", () => {
    const d = new ResolveDirector();
    d.begin({ x: 0, z: 0 });
    d.note(20, -10, POI_WEIGHT.blast, 2);
    const frame = step(d, 1.2);
    expect(frame.focus).toBeDefined();
    // Eased, not snapped: it should be well on its way without having arrived instantly.
    expect(frame.focus!.x).toBeGreaterThan(8);
    expect(frame.focus!.x).toBeLessThanOrEqual(20);
  });

  it("prefers a kill over routine gunfire", () => {
    const d = new ResolveDirector();
    d.begin({ x: 0, z: 0 });
    d.note(-20, 0, POI_WEIGHT.shot, 2);
    d.note(20, 0, POI_WEIGHT.kill, 2);
    const frame = step(d, 1.5);
    expect(frame.focus!.x).toBeGreaterThan(0);
  });

  it("does not ping-pong between two similar firefights", () => {
    // The failure this prevents: two equally interesting fights, and a camera that swings between
    // them every time a new shot lands, so the player watches neither.
    const d = new ResolveDirector();
    d.begin({ x: 0, z: 0 });
    d.note(-20, 0, POI_WEIGHT.impact, 4);
    step(d, 0.6);
    const settled = d.update(0).focus!.x;
    for (let i = 0; i < 8; i += 1) {
      d.note(20, 0, POI_WEIGHT.impact, 4); // the rival fight, equally weighted
      step(d, 0.2);
    }
    const after = d.update(0).focus!.x;
    expect(Math.sign(after)).toBe(Math.sign(settled));
  });

  it("yields to the player and comes back on its own", () => {
    const d = new ResolveDirector();
    d.begin({ x: 0, z: 0 });
    d.note(20, 0, POI_WEIGHT.blast, 30);
    d.playerTookControl();
    expect(step(d, 1).focus).toBeUndefined(); // hands off while they are looking around
    expect(d.debugState().yieldingToPlayer).toBe(true);
    expect(step(d, 2.5).focus).toBeDefined(); // and takes the reins back afterwards
  });

  it("releases instead of staring at a spot forever", () => {
    const d = new ResolveDirector();
    d.begin({ x: 0, z: 0 });
    d.note(20, 0, POI_WEIGHT.kill, 1);
    step(d, 0.5);
    expect(d.debugState().holding).toBe(true);
    step(d, 2);
    expect(d.debugState().holding).toBe(false);
  });

  it("counts hitstop down and never below zero", () => {
    const d = new ResolveDirector();
    d.begin();
    d.freeze(0.12);
    expect(d.update(0.05).hitstop).toBeGreaterThan(0);
    expect(step(d, 0.4).hitstop).toBe(0);
  });

  it("takes the longest freeze rather than stacking them", () => {
    // Three kills in one volley must not add up to a half-second lockup.
    const d = new ResolveDirector();
    d.begin();
    d.freeze(0.1);
    d.freeze(0.14);
    d.freeze(0.08);
    expect(d.update(0).hitstop).toBeCloseTo(0.14, 3);
  });

  it("stays out of the way entirely when disabled", () => {
    const d = new ResolveDirector();
    d.enabled = false;
    d.begin({ x: 0, z: 0 });
    d.note(20, 0, POI_WEIGHT.kill, 5);
    expect(step(d, 1).focus).toBeUndefined();
  });
});
