import { describe, expect, it } from "vitest";
import { STRIKER_CHARGE, TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round three (unit-identity picks 1, 3, 11):
// striker CHARGE, sapper BREACH. (Scout DASH went with Overwatch, 2026-09-23.)
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); return sim; };
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);

describe("striker charge", () => {
  it("accepts a strike from STRIKER_CHARGE metres out, runs in, and lands it", () => {
    const sim = staged();
    const striker = sim.debugSpawn("striker", "player", { x: -6, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: -6 + STRIKER_CHARGE - 0.4 + striker.radius + 0.4, z: 0 });
    disarm(target);
    const before = hp(target);
    sim.debugSelect(striker.id);
    expect(sim.queueMelee(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(hp(target)).toBeLessThan(before);
    // It physically closed the distance (the blow itself shoves the target a step after).
    expect(striker.position.x).toBeGreaterThan(-3);
  });

  it("a plain soldier RUSHES a short way in the same order, and no further than a striker charges", () => {
    // 4m apart: inside MELEE_RUSH (3.5) + the bodies, so one order closes and strikes.
    const near = staged();
    const soldier = near.debugSpawn("soldier", "player", { x: -6, z: 0 });
    const target = near.debugSpawn("soldier", "enemy", { x: -2, z: 0 });
    near.debugSelect(soldier.id);
    expect(near.queueMelee(target.id)).toBe(true);
    // 7m apart: past a soldier's rush, but inside a striker's charge.
    const far = staged();
    const rifle = far.debugSpawn("soldier", "player", { x: -9, z: 0 });
    const striker = far.debugSpawn("striker", "player", { x: -9, z: 3 });
    const mark = far.debugSpawn("soldier", "enemy", { x: -2, z: 1.5 });
    far.debugSelect(rifle.id);
    expect(far.queueMelee(mark.id)).toBe(false);
    far.debugSelect(striker.id);
    expect(far.queueMelee(mark.id)).toBe(true);
  });
});

describe("sapper breach", () => {
  it("takes a full-HP wall piece down in one shot; a rifle only chips it", () => {
    for (const [kind, expectDead] of [["sapper", true], ["soldier", false]] as const) {
      const sim = staged();
      const shooter = sim.debugSpawn(kind, "player", { x: -3, z: 0 });
      const wall = sim.debugCover("wall", { x: 0, z: 0 });
      sim.debugSelect(shooter.id);
      expect(sim.queueShoot(wall.id)).toBe(true);
      sim.endTurn();
      settle(sim);
      expect(!wall.status.alive).toBe(expectDead);
    }
  });
});
