import { describe, expect, it } from "vitest";
import { createSoldier, createTank } from "./damageModel";
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
});

function advance(sim: TacticalSim, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.05) sim.update(0.05);
}
