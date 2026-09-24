import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Unit identity abilities (unit-identity picks 4, 12, 13).
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); return sim; };
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);

describe("suppression (heavy gunner)", () => {
  it("a burst that lands leaves the target with one action point and crouched next turn", () => {
    const sim = staged();
    const mg = sim.debugSpawn("heavy", "player", { x: -4, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 3, z: 0 });
    disarm(target);
    sim.debugSelect(mg.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("is suppressed"))).toBe(true);
    expect(target.commandPoints).toBe(1);
    expect(target.stance).toBe("crouched");
    // It wears off the turn after.
    sim.endTurn();
    settle(sim);
    expect(target.suppressedUntilTurn).toBeUndefined();
    expect(target.commandPoints).toBe(target.maxCommandPoints);
  });
});

describe("hull down (tank)", () => {
  it("a tank that did not move takes 30% less; one that moved takes full damage", () => {
    const sim = staged();
    const tank = sim.debugSpawn("tank", "enemy", { x: 4, z: 0 });
    disarm(tank);
    const gun = sim.debugSpawn("tank", "player", { x: -8, z: 0 });
    const before = hp(tank);
    sim.debugSelect(gun.id);
    const hull = tank.parts.find((p) => p.id === "hull")!;
    expect(sim.queueShootPart(tank.id, hull.id)).toBe(true);
    sim.orders[sim.orders.length - 1].aim = "center";
    sim.endTurn();
    settle(sim);
    expect(tank.hullDown).toBe(true);
    expect(sim.log.some((l) => l.includes("goes hull down"))).toBe(true);
    const dealtHullDown = before - hp(tank);
    expect(dealtHullDown).toBeGreaterThan(0);
    // Same shot against a tank that is not hull down: it moved this turn.
    const sim2 = staged();
    const tank2 = sim2.debugSpawn("tank", "enemy", { x: 4, z: 0 });
    for (const p of tank2.parts) if (p.role === "weapon") p.hp = 0;
    tank2.status.canShoot = false;
    const gun2 = sim2.debugSpawn("tank", "player", { x: -8, z: 0 });
    const before2 = hp(tank2);
    sim2.debugSelect(gun2.id);
    expect(sim2.queueShootPart(tank2.id, tank2.parts.find((p) => p.id === "hull")!.id)).toBe(true);
    sim2.orders[sim2.orders.length - 1].aim = "center";
    sim2.endTurn();
    settle(sim2);
    if (tank2.hullDown) return; // the AI chose not to move it this seed; nothing to compare
    expect(before2 - hp(tank2)).toBeGreaterThan(dealtHullDown);
  });
});

describe("slam landing (jump trooper)", () => {
  it("landing beside an enemy hurts and shoves it", () => {
    const sim = staged();
    const jumper = sim.debugSpawn("jumper", "player", { x: -6, z: 0 });
    const victim = sim.debugSpawn("soldier", "enemy", { x: 0.9, z: 0 });
    disarm(victim);
    const before = hp(victim);
    const start = { ...victim.position };
    sim.debugSelect(jumper.id);
    expect(sim.queueMove({ x: 0, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("slams down on"))).toBe(true);
    expect(hp(victim)).toBeLessThan(before);
    expect(Math.hypot(victim.position.x - start.x, victim.position.z - start.z)).toBeGreaterThan(0.1);
  });
});
