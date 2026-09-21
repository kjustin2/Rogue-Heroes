// Placed deploy: the player picks WHERE inside the ring around the base a troop is fielded.
// Mirrors the build flow (pendingBuild / buildPlacement / queueBuildStructure) — the pending
// kind is command-phase UI state, never serialized, and a rejection never costs anything.

import { describe, expect, it } from "vitest";
import { createBase, createCover, createSoldier } from "./damageModel";
import { DEPLOY_SNAP, TacticalSim, troopSpec } from "./sim";
import { dist } from "../core/math";

function armed(): { sim: TacticalSim; base: ReturnType<typeof createBase> } {
  const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
  const sim = new TacticalSim([base]);
  sim.economy.set("player", 3000);
  sim.select("p-base-1");
  sim.setPendingDeploy("soldier");
  return { sim, base };
}

function spawned(sim: TacticalSim) {
  return sim.entities.find((e) => e.id.startsWith("p-spawn-"));
}

describe("placed deploy", () => {
  it("arming a card shows the ring around the base and sets the deploy intent", () => {
    const { sim, base } = armed();
    expect(sim.intent).toBe("deploy");
    const ring = sim.deployPlacement();
    expect(ring).toBeDefined();
    expect(ring!.center).toEqual(base.position);
    expect(ring!.radius).toBe(sim.deployPlacementRadius(base));
    // Arming a build cancels the deploy (one placement at a time), and vice versa.
    sim.setPendingBuild("wall");
    expect(sim.pendingDeploy).toBeUndefined();
    expect(sim.deployPlacement()).toBeUndefined();
    sim.setPendingDeploy("soldier");
    expect(sim.pendingBuild).toBeUndefined();
  });

  it("accepts a clear point inside the ring and fields the troop exactly there, paying once", () => {
    const { sim, base } = armed();
    const point = { x: base.position.x + 4, z: base.position.z + 2 };
    const cost = troopSpec("soldier").cost;
    const money = sim.money("player");
    expect(sim.queueDeployAt("soldier", point)).toBe(true);
    const unit = spawned(sim)!;
    expect(unit.kind).toBe("soldier");
    expect(unit.position.x).toBeCloseTo(point.x, 5);
    expect(unit.position.z).toBeCloseTo(point.z, 5);
    expect(sim.money("player")).toBe(money - cost);
    expect(base.commandPoints).toBe(0);
    expect(unit.commandPoints).toBe(0);
    // The placement clears itself once the troop is down.
    expect(sim.pendingDeploy).toBeUndefined();
    expect(sim.intent).toBe("select");
    expect(sim.deployPlacement()).toBeUndefined();
  });

  it("rejects a point outside the ring at no cost", () => {
    const { sim, base } = armed();
    const far = { x: base.position.x + sim.deployPlacementRadius(base) + 3, z: base.position.z };
    const money = sim.money("player");
    expect(sim.queueDeployAt("soldier", far)).toBe(false);
    expect(sim.log[0]).toContain("inside the ring");
    expect(spawned(sim)).toBeUndefined();
    expect(sim.money("player")).toBe(money);
    expect(base.commandPoints).toBe(1);
    // Still armed: the player can try another spot.
    expect(sim.pendingDeploy).toBe("soldier");
  });

  it("snaps a blocked point to the nearest clear spot within reach, else rejects with a reason", () => {
    const { sim, base } = armed();
    // A trooper already standing on the clicked spot: the new one slides beside it.
    const blocker = createSoldier("p-blocker", "Blocker", "player", { x: base.position.x + 4, z: base.position.z + 2 });
    sim.entities.push(blocker);
    const preview = sim.deployPointPreview(base, "soldier", blocker.position);
    expect(preview.reason).toBeUndefined();
    expect(preview.snapped).toBe(true);
    expect(dist(preview.point, blocker.position)).toBeLessThanOrEqual(DEPLOY_SNAP + 0.65 + 1e-6);
    expect(dist(preview.point, blocker.position)).toBeGreaterThanOrEqual(blocker.radius + 0.5 + 0.3 - 1e-6);
    expect(sim.queueDeployAt("soldier", blocker.position)).toBe(true);
    const unit = spawned(sim)!;
    expect(unit.position).toEqual(preview.point);

    // Wall the spot in with a ring of crates wider than the snap reach: no room, nothing spent.
    base.commandPoints = 1;
    base.spawnCooldowns = {};
    sim.setPendingDeploy("soldier");
    const centre = { x: base.position.x - 4, z: base.position.z + 3 };
    for (let i = 0; i < 12; i += 1) {
      const a = (Math.PI * 2 * i) / 12;
      for (const r of [0.6, 1.4, 2.2]) {
        sim.entities.push(createCover(`c-ring-${i}-${r}`, "Crate", { x: centre.x + Math.sin(a) * r, z: centre.z + Math.cos(a) * r }, { coverKind: "crate" }));
      }
    }
    const money = sim.money("player");
    expect(sim.queueDeployAt("soldier", centre)).toBe(false);
    expect(sim.log[0]).toContain("No room");
    expect(sim.money("player")).toBe(money);
    expect(base.commandPoints).toBe(1);
  });

  it("cancelling costs nothing and clears the ring; quick deploy still lands beside the base", () => {
    const { sim, base } = armed();
    const money = sim.money("player");
    sim.setPendingDeploy(undefined);
    expect(sim.pendingDeploy).toBeUndefined();
    expect(sim.intent).toBe("select");
    expect(sim.deployPlacement()).toBeUndefined();
    expect(sim.money("player")).toBe(money);
    expect(base.commandPoints).toBe(1);
    expect(spawned(sim)).toBeUndefined();

    // The quick path (tutorial / AI / smokes) is untouched and also clears an armed placement.
    sim.setPendingDeploy("soldier");
    expect(sim.queueSpawnTroop("soldier")).toBe(true);
    expect(sim.pendingDeploy).toBeUndefined();
    expect(dist(spawned(sim)!.position, base.position)).toBeLessThan(6);
  });

  it("does not serialize the pending placement", () => {
    const { sim } = armed();
    const json = JSON.stringify(sim.serialize());
    expect(json).not.toContain("pendingDeploy");
    const copy = new TacticalSim();
    copy.restore(sim.serialize());
    expect(copy.pendingDeploy).toBeUndefined();
    expect(copy.intent).toBe("select");
  });
});
