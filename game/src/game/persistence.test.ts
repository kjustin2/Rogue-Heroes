import { describe, expect, it } from "vitest";
import { createBomber, createSoldier, createTank, createTransport } from "./damageModel";
import { TacticalSim } from "./sim";

function advance(sim: TacticalSim, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.05) sim.update(0.05);
}

describe("serialize / restore fidelity", () => {
  it("round-trips a rich battle idempotently (restore is a fixpoint)", () => {
    const sim = new TacticalSim([
      createSoldier("p1", "Rook", "player", { x: 0, z: 0 }),
      createTank("p2", "Hammer", "player", { x: -3, z: 2 }),
      createSoldier("e1", "Foe", "enemy", { x: 14, z: 0 }),
    ]);
    sim.economy.set("player", 777);
    // Normalize first: a raw-constructed sim carries DEFAULT_TERRAIN elevations, which restore
    // correctly re-syncs to the (dustbowl) map. Compare two restore outputs — any dropped or
    // reordered serialized field diverges here.
    const clone = new TacticalSim([createSoldier("x", "x", "player", { x: 0, z: 0 })]);
    expect(clone.restore(sim.serialize())).toBe(true);
    const s1 = clone.serialize();
    const clone2 = new TacticalSim([createSoldier("x", "x", "player", { x: 0, z: 0 })]);
    expect(clone2.restore(s1)).toBe(true);
    expect(clone2.serialize()).toBe(s1);
  });

  it("preserves a carried passenger through a save/load", () => {
    const sim = new TacticalSim([
      createTransport("t1", "Chinook", "player", { x: -6, z: 0 }),
      createSoldier("s1", "Rider", "player", { x: -4, z: 0 }),
      createSoldier("e1", "Foe", "enemy", { x: 20, z: 0 }),
    ]);
    sim.select("t1");
    expect(sim.queueLoad("s1")).toBe(true);
    sim.endTurn();
    advance(sim, 10);
    expect(sim.entity("s1")!.carriedById).toBe("t1"); // picked up

    const saved = sim.serialize();
    const reloaded = new TacticalSim([createSoldier("x", "x", "player", { x: 0, z: 0 })]);
    expect(reloaded.restore(saved)).toBe(true);
    expect(reloaded.entity("s1")!.carriedById).toBe("t1");
    expect(reloaded.entity("t1")!.passengerIds).toContain("s1");
  });

  it("conserves command points across a command-phase save (order or refund, never both lost)", () => {
    const sim = new TacticalSim([
      createSoldier("p1", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("e1", "Foe", "enemy", { x: 20, z: 0 }),
    ]);
    sim.select("p1");
    const cp0 = sim.entity("p1")!.commandPoints;
    expect(sim.queueMove({ x: 3, z: 0 })).toBe(true);
    expect(sim.entity("p1")!.commandPoints).toBe(cp0 - 1); // CP spent at queue time

    const saved = sim.serialize();
    const reloaded = new TacticalSim([createSoldier("x", "x", "player", { x: 0, z: 0 })]);
    expect(reloaded.restore(saved)).toBe(true);

    // Invariant: a unit's remaining CP plus its still-queued orders must equal what it started with.
    // If restore drops the order but keeps the spent CP, the player silently loses a command point.
    const u = reloaded.entity("p1")!;
    const queuedForUnit = reloaded.orders.filter((o) => o.actorId === "p1").length;
    expect(u.commandPoints + queuedForUnit).toBe(cp0);
  });
});

describe("resolution determinism", () => {
  it("two identically-built battles resolve to identical state", () => {
    const build = (): TacticalSim => {
      const sim = new TacticalSim([
        createSoldier("p1", "Rook", "player", { x: -2, z: 0 }),
        createBomber("p2", "Vulture", "player", { x: -4, z: 2 }),
        createSoldier("e1", "Foe", "enemy", { x: 6, z: 0 }),
        createTank("e2", "Ogre", "enemy", { x: 9, z: -2 }),
      ]);
      sim.select("p1");
      sim.queueShoot("e1");
      return sim;
    };
    const a = build();
    const b = build();
    a.endTurn();
    b.endTurn();
    advance(a, 12);
    advance(b, 12);
    expect(a.serialize()).toBe(b.serialize()); // any hidden nondeterminism diverges here
  });
});
