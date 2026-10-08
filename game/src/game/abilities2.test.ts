import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round two (unit-identity picks 2, 6, 7):
// sniper MARK, mortar SMOKE round, medic STABILISE.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); return sim; };
// The enemy AI moves and shoots its units during the resolve; take their legs and weapon so the
// staging stays where it was put.
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);
const core = (e: ReturnType<TacticalSim["debugSpawn"]>) => e.parts.find((p) => p.role === "core")!;

describe("mortar smoke round", () => {
  it("lands a 3-turn cloud that blocks flat shots (not arcing ones) and shrinks away", () => {
    const sim = staged();
    const mortar = sim.debugSpawn("mortar", "player", { x: -8, z: 0 });
    const rifle = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    disarm(target);
    sim.debugSelect(mortar.id);
    expect(sim.queueSmokeAt({ x: 2, z: 0 })).toBe(true);
    expect(mortar.commandPoints).toBe(mortar.maxCommandPoints - 1);
    sim.endTurn();
    settle(sim);
    expect(sim.smokeClouds.length).toBe(1);
    expect(sim.smokeClouds[0]).toMatchObject({ radius: 3, turnsLeft: 2 }); // one turn start has already ticked it
    expect(Math.hypot(sim.smokeClouds[0].x - 2, sim.smokeClouds[0].z)).toBeLessThan(0.5);
    expect(sim.log.some((l) => l.includes("smoke round blooms"))).toBe(true);
    expect(hp(target)).toBe(target.parts.reduce((s, p) => s + p.maxHp, 0) - target.parts.filter((p) => p.role === "mobility" || p.role === "weapon").reduce((s, p) => s + p.maxHp, 0)); // smoke harms nothing

    // A flat rifle shot whose line crosses the cloud is blocked in the preview and refused as an order.
    const preview = sim.previewShot(rifle.id, target.id, core(target).id)!;
    expect(preview.blockedBySmoke).toBe(true);
    expect(preview.amount).toBe(0);
    sim.debugSelect(rifle.id);
    expect(sim.queueShoot(target.id)).toBe(false);
    expect(sim.log.some((l) => l.includes("hidden by smoke"))).toBe(true);
    // The mortar's own arcing round sails over it.
    const arc = sim.previewShot(mortar.id, target.id, core(target).id)!;
    expect(arc.blockedBySmoke).toBe(false);
    sim.debugSelect(mortar.id);
    expect(sim.queueShootAt({ x: 8, z: 0 })).toBe(true);

    // Clouds last three turn starts, then vanish.
    sim.endTurn(); settle(sim);
    expect(sim.smokeClouds[0]?.turnsLeft).toBe(1);
    sim.endTurn(); settle(sim);
    expect(sim.smokeClouds.length).toBe(0);
  });

  it("swallows a flat round already in flight", () => {
    const sim = staged();
    const rifle = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });
    disarm(target);
    const before = hp(target);
    sim.debugSelect(rifle.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    // The cloud appears after the order is given (a mortar round from elsewhere would do this).
    sim.smokeClouds.push({ id: "smoke-test", x: 1, z: 0, radius: 3, turnsLeft: 3 });
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("lost in the smoke"))).toBe(true);
    expect(hp(target)).toBe(before);
  });

  it("is a mortar-only order that survives a save/restore round trip", () => {
    const sim = staged();
    const soldier = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    sim.debugSelect(soldier.id);
    expect(sim.queueSmokeAt({ x: 0, z: 0 })).toBe(false);
    sim.smokeClouds.push({ id: "smoke-1", x: 3, z: 2, radius: 3, turnsLeft: 2 });
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    expect(copy.smokeClouds).toEqual(sim.smokeClouds);
  });
});

