import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// LOCAL 2-PLAYER: both seats plan through the same "player" UI via swapSides(); the AI never
// orders, and the resolve always runs with Player 1 as "player".
describe("hotseat", () => {
  it("each human's orders survive the swap, the AI adds none, and the resolve runs unswapped", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal", { player: "vanguard", enemy: "bastion" }, true);
    const p1 = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    const p2 = sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });
    const cash1 = sim.economy.get("player");
    sim.economy.set("enemy", 777);

    sim.select(p1.id);
    expect(sim.queueMove({ x: -4, z: 0 })).toBe(true);

    sim.swapSides(); // Player 2's turn to plan
    expect(sim.sidesSwapped).toBe(true);
    expect(p2.team).toBe("player");
    expect(p1.team).toBe("enemy");
    expect(sim.economy.get("player")).toBe(777);
    expect(sim.factionIdOf("player")).toBe("bastion");
    sim.select(p2.id);
    expect(sim.queueMove({ x: 4, z: 0 })).toBe(true);

    sim.endTurn();
    expect(sim.sidesSwapped).toBe(false);
    expect(p1.team).toBe("player");
    expect(sim.economy.get("player")).toBe(cash1);
    expect(sim.factionIdOf("player")).toBe("vanguard");
    const actors = sim.orders.map((o) => o.actorId).sort();
    expect(actors).toEqual([p1.id, p2.id].sort()); // no AI orders on top
  });

  it("round-trips the hotseat flag through a save", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("verdant"), "hill", "normal", undefined, true);
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    expect(copy.hotseat).toBe(true);
  });
});
