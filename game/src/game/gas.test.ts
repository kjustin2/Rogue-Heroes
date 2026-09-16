import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Item 13 of the fun pass: a shot-out gas canister LEAKS instead of exploding, the cloud grows
// every turn and chokes whoever stands in it, and any blast inside it detonates the whole cloud.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal");
  return sim;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((sum, p) => sum + p.hp, 0);
// The enemy AI moves its units during the resolve, which would walk a victim out of the cloud
// before the choke tick; pin them in place by taking their legs.
const pin = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility") p.hp = 0;
  e.status.canMove = false;
};

describe("gas canisters", () => {
  it("leak a cloud when destroyed, which spreads each turn and chokes infantry inside it", () => {
    const sim = staged();
    const can = sim.debugCover("gas", { x: 0, z: 0 });
    const bystander = sim.debugSpawn("soldier", "enemy", { x: 1.2, z: 0 });
    pin(bystander);
    const before = hp(bystander);
    sim.debugDamage(can.id, can.parts[0].id, 999, bystander.id); // a source is what routes to afterDamage -> rupture
    expect(sim.gasClouds.length).toBe(1);
    expect(sim.log.some((l) => l.includes("gas is spreading"))).toBe(true);
    const r0 = sim.gasClouds[0].radius;
    sim.endTurn();
    settle(sim);
    expect(sim.gasClouds[0].radius).toBeGreaterThan(r0);
    expect(hp(bystander)).toBeLessThan(before);
    expect(sim.log.some((l) => l.includes("choking"))).toBe(true);
  });

  it("detonates the whole cloud when a grenade goes off inside it", () => {
    const sim = staged();
    const can = sim.debugCover("gas", { x: 0, z: 0 });
    const victim = sim.debugSpawn("soldier", "enemy", { x: 1.5, z: 0 });
    pin(victim);
    sim.debugDamage(can.id, can.parts[0].id, 999, victim.id);
    const before = hp(victim);
    const thrower = sim.debugSpawn("soldier", "player", { x: 0, z: 7 });
    thrower.maxGrenades = 3;
    thrower.grenades = 3;
    sim.debugSelect(thrower.id);
    expect(sim.queueGrenadeAt({ x: 0, z: 0.5 })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.gasClouds.length).toBe(0);
    expect(sim.log.some((l) => l.includes("gas ignites"))).toBe(true);
    // A grenade alone at 1.5m is survivable; the cloud going up on top of it is not what it was.
    expect(before - hp(victim)).toBeGreaterThan(34);
  });

  it("survives a save/restore round trip", () => {
    const sim = staged();
    const can = sim.debugCover("gas", { x: 3, z: 2 });
    const shooter = sim.debugSpawn("soldier", "player", { x: 8, z: 2 });
    sim.debugDamage(can.id, can.parts[0].id, 999, shooter.id);
    expect(sim.gasClouds.length).toBe(1);
    const json = sim.serialize();
    const copy = new TacticalSim();
    expect(copy.restore(json)).toBe(true);
    expect(copy.gasClouds).toEqual(sim.gasClouds);
  });
});
