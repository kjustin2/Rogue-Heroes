import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { ARENA_BOUNDS } from "./terrain";

// PUSH (owner 2026-09-24): "a push ability that pushes a unit super far and if it pushes them into
// something like water or off the map then it kills them". Since 2026-10-07 every STRIKE throws (the Push card is the
// Breaker's Punch), so these hold the knockback of a plain soldier's Strike.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 60 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); sim.economy.set("enemy", 0); return sim; };
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);

describe("every strike throws", () => {
  it("throws a trooper far across open ground", () => {
    const sim = staged();
    const pusher = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const victim = sim.debugSpawn("soldier", "enemy", { x: -2.6, z: 0 });
    for (const p of victim.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
    sim.debugSelect(pusher.id);
    const x0 = victim.position.x;
    expect(sim.queueMelee(victim.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(victim.position.x - x0).toBeGreaterThan(2); // a blow sends a trooper a few metres (the Breaker's punch goes ~18m)
  });

  it("shoves a trooper off the edge of the map and it is gone", () => {
    const sim = staged();
    const edge = ARENA_BOUNDS.minZ;
    const victim = sim.debugSpawn("soldier", "enemy", { x: 0, z: edge + 1.2 });
    const pusher = sim.debugSpawn("soldier", "player", { x: 0, z: edge + 2.6 });
    for (const p of victim.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
    const before = hp(victim);
    sim.debugSelect(pusher.id);
    expect(sim.queueMelee(victim.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(before).toBeGreaterThan(0);
    expect(victim.status.alive).toBe(false);
    expect(sim.log.some((l) => l.includes("off the battlefield"))).toBe(true);
  });

  it("never moves a tank", () => {
    const sim = staged();
    const pusher = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const tank = sim.debugSpawn("tank", "enemy", { x: -0.5, z: 0 });
    for (const p of tank.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
    tank.status.canMove = false; tank.status.canShoot = false;
    sim.debugSelect(pusher.id);
    const x0 = tank.position.x;
    expect(sim.queueMelee(tank.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(tank.position.x - x0).toBe(0);
    expect(tank.status.alive).toBe(true);
  });
});
