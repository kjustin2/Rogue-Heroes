import { describe, expect, it } from "vitest";
import { createBase } from "./damageModel";
import { TacticalSim } from "./sim";

// ROTATABLE PLACEMENT (owner 2026-09-24): "for a wall or an air strike a user can turn the direction".
describe("rotatable placement", () => {
  const staged = () => {
    const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
    const sim = new TacticalSim([base, createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 })]);
    sim.economy.set("player", 5000);
    base.unlockedTech = ["recon", "support", "assault"];
    base.commandPoints = 2;
    sim.select(base.id);
    return { sim, base };
  };
  const queued = (sim: TacticalSim) => (sim as unknown as { queuedSupport: { dir: { x: number; z: number } }[] }).queuedSupport;

  it("a line strike runs away from the base by default, and two turns swing it 90 degrees", () => {
    const a = staged();
    a.sim.setPendingSupport("airstrike");
    expect(a.sim.queueSupportAt({ x: 0, z: 0 })).toBe(true);
    expect(queued(a.sim)[0].dir.x).toBeCloseTo(1); // base at -x: the line runs along +x
    const b = staged();
    b.sim.setPendingSupport("airstrike");
    b.sim.rotatePlacement(2);
    expect(b.sim.queueSupportAt({ x: 0, z: 0 })).toBe(true);
    expect(Math.abs(queued(b.sim)[0].dir.z)).toBeCloseTo(1); // turned across the field
    expect(queued(b.sim)[0].dir.x).toBeCloseTo(0);
  });

  it("a wall is built facing the way it was turned, and a new placement starts unturned", () => {
    const { sim, base } = staged();
    sim.setPendingBuild("wall");
    sim.rotatePlacement(1);
    expect(sim.queueBuildStructure({ x: -8, z: 0 })).toBe(true);
    const wall = sim.entities.find((e) => e.kind === "wall")!;
    expect(wall.yaw).toBeCloseTo(Math.atan2(6, 0) + Math.PI / 4);
    base.commandPoints = 1;
    sim.setPendingBuild("wall");
    expect(sim.placementTurn).toBe(0);
  });
});
