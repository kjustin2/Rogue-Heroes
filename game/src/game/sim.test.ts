import { describe, expect, it } from "vitest";
import { createCover, createSoldier, createTank } from "./damageModel";
import { TacticalSim } from "./sim";

describe("tactical simulation loop", () => {
  it("resolves queued target fire back into a new command phase", () => {
    const sim = new TacticalSim();

    sim.select("p-tank-1");
    sim.setAim("mobility");

    expect(sim.queueShoot("e-tank-1")).toBe(true);
    expect(sim.orders).toHaveLength(1);

    sim.endTurn();
    advance(sim, 4);

    const enemyTank = sim.entity("e-tank-1");
    const leftTread = enemyTank?.parts.find((part) => part.id === "left-tread");

    expect(sim.phase).toBe("command");
    expect(sim.turn).toBe(2);
    expect(leftTread?.hp).toBeLessThan(34);
  });

  it("does not let tank rams target friendly units", () => {
    const sim = new TacticalSim();

    sim.select("p-tank-1");

    expect(sim.queueRam("p-soldier-1")).toBe(false);
    expect(sim.orders).toHaveLength(0);
    expect(sim.log[0]).toBe("Cannot ram friendly units");
  });

  it("can finish a one-fight victory from normal queued combat", () => {
    const sim = new TacticalSim([
      createTank("player-tank", "Hammer", "player", { x: 0, z: 0 }),
      createSoldier("enemy-scout", "Scout", "enemy", { x: 2, z: 0 }),
    ]);

    sim.select("player-tank");
    sim.setAim("head");

    expect(sim.queueShoot("enemy-scout")).toBe(true);
    sim.endTurn();
    advance(sim, 4);

    expect(sim.phase).toBe("victory");
    expect(sim.log).toContain("Enemy force disabled");
  });

  it("only exposes intact parts that exist on the selected target type", () => {
    const sim = new TacticalSim();
    const enemyTank = sim.entity("e-tank-1");
    const enemySoldier = sim.entity("e-soldier-1");

    expect(enemyTank).toBeDefined();
    expect(enemySoldier).toBeDefined();
    expect(sim.targetableParts(enemyTank!).map((part) => part.id)).toEqual([
      "hull",
      "turret",
      "cannon",
      "left-tread",
      "right-tread",
      "front-plate",
    ]);
    expect(sim.targetableParts(enemySoldier!).map((part) => part.id)).toEqual(["body", "head", "rifle", "pack"]);

    sim.select("p-soldier-1");
    expect(sim.queueShootPart("e-tank-1", "head")).toBe(false);
    expect(sim.orders).toHaveLength(0);
    expect(sim.log[0]).toBe("Breaker does not have that targetable part");
  });

  it("previews and resolves shots into blocking cover before the intended enemy part", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 3, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: 0 }),
    ]);

    const preview = sim.previewShot("player", "enemy", "head");

    expect(preview?.blockedById).toBe("wall");
    expect(preview?.impactEntityId).toBe("wall");
    expect(preview?.impactPartId).toBe("wall");

    sim.select("player");
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    advance(sim, 4);

    const wall = sim.entity("wall");
    const enemy = sim.entity("enemy");
    expect(wall?.parts[0].hp).toBeLessThan(70);
    expect(enemy?.parts.find((part) => part.id === "head")?.hp).toBe(16);
    expect(sim.log).toContain("Concrete Wall intercepts shot at Cutlass");
  });
});

function advance(sim: TacticalSim, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.05) sim.update(0.05);
}
