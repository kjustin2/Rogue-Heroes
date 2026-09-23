import { describe, expect, it } from "vitest";
import { STRIKER_CHARGE, TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round three (unit-identity picks 1, 3, 11):
// scout DASH, striker CHARGE, sapper BREACH.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); return sim; };
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);

describe("scout dash", () => {
  it("never triggers enemy overwatch, where a soldier on the same path does", () => {
    for (const [kind, expectReaction] of [["scout", false], ["soldier", true]] as const) {
      const sim = staged();
      const watcher = sim.debugSpawn("soldier", "enemy", { x: 0, z: 0 });
      disarm(watcher); watcher.status.canShoot = true; // stays put, still shoots
      sim.overwatching.set(watcher.id, 1);
      sim.overwatchFacing.set(watcher.id, Math.atan2(-1, 0)); // watching -x
      const runner = sim.debugSpawn(kind, "player", { x: -9, z: 0 });
      sim.debugSelect(runner.id);
      expect(sim.queueMove({ x: -4, z: 0 })).toBe(true);
      sim.endTurn();
      settle(sim);
      expect(sim.log.some((l) => l.includes("reaction fire"))).toBe(expectReaction);
    }
  });
});

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

  it("a plain soldier still has to be adjacent to strike", () => {
    const sim = staged();
    const soldier = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: -2, z: 0 });
    sim.debugSelect(soldier.id);
    expect(sim.queueMelee(target.id)).toBe(false);
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
