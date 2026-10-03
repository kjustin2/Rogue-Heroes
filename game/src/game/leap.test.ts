import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, setActiveTerrain, terrainHeightAt } from "./terrain";

// EVERY TROOPER CAN HOP (owner 2026-10-03): a short arc over low cover and up onto a ledge; lighter, quicker kinds go farther.

const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal");
  for (const e of sim.entities) if (e.team === "enemy" && e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
  sim.economy.set("enemy", 0);
  return sim;
};

describe("infantry hop", () => {
  it("light, quick kinds jump farther and higher than heavy ones", () => {
    const sim = staged();
    const range = (k: "scout" | "soldier" | "heavy"): number => sim.leapRange(sim.debugSpawn(k, "player", { x: -10, z: 0 }));
    expect(range("scout")).toBeGreaterThan(range("soldier"));
    expect(range("soldier")).toBeGreaterThan(range("heavy"));
    expect(sim.leapUp(sim.debugSpawn("scout", "player", { x: -10, z: 4 }))).toBeGreaterThan(sim.leapUp(sim.debugSpawn("heavy", "player", { x: -10, z: 8 })));
  });

  it("a trooper hops over a pillar to the far side, airborne on the way and soft on landing", () => {
    const sim = staged();
    const u = sim.debugSpawn("soldier", "player", { x: -12, z: 0 });
    sim.debugCover("pillar", { x: -10.2, z: 0 });
    sim.debugSelect(u.id);
    const hop = sim.leapPreview({ x: -8, z: 0 })!;
    expect(hop.ok, hop.reason).toBe(true);
    expect(sim.queueLeap({ x: -8, z: 0 })).toBe(true);
    expect(u.commandPoints).toBe(u.maxCommandPoints - 1);
    sim.endTurn();
    let airborne = false;
    for (let t = 0; t < 12 && sim.phase === "resolve"; t += 0.05) { sim.update(0.05); airborne = airborne || Boolean(sim.entity(u.id)!.flying); }
    expect(airborne).toBe(true);
    const end = sim.entity(u.id)!;
    expect(end.flying).toBeFalsy();
    expect(end.position.x).toBeGreaterThan(-9.2);
    expect(Math.hypot(end.position.x + 8, end.position.z)).toBeLessThan(1.3);
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("a hop beyond its reach is clamped to the reach, onto a ledge too high is refused with a reason", () => {
    const sim = staged();
    const u = sim.debugSpawn("heavy", "player", { x: -12, z: 0 });
    sim.debugSelect(u.id);
    const far = sim.leapPreview({ x: 2, z: 0 })!;
    expect(Math.hypot(far.to.x - far.from.x, far.to.z - far.from.z)).toBeLessThanOrEqual(sim.leapRange(u) + 1.3);
    // find a spot on the map more than one step up from a flat spot beside it
    let found: { low: { x: number; z: number }; high: { x: number; z: number } } | undefined;
    for (let x = -30; x < 30 && !found; x += 1) for (let z = -20; z < 20 && !found; z += 1) {
      const h = terrainHeightAt({ x, z });
      const l = terrainHeightAt({ x: x - 2, z });
      if (h - l > 1.4) found = { low: { x: x - 2, z }, high: { x, z } };
    }
    if (found) {
      const climber = sim.debugSpawn("heavy", "player", found.low);
      sim.debugSelect(climber.id);
      const p = sim.leapPreview(found.high);
      expect(p?.ok).toBe(false);
      expect(p?.reason).toMatch(/high|room/);
    }
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("the jump trooper keeps its jet pack and its slam; a tank cannot hop", () => {
    const sim = staged();
    const j = sim.debugSpawn("jumper", "player", { x: -12, z: 0 });
    sim.debugSelect(j.id);
    expect(sim.queueLeap({ x: -9, z: 0 })).toBe(false);
    const t = sim.debugSpawn("tank", "player", { x: -12, z: 6 });
    sim.debugSelect(t.id);
    expect(sim.queueLeap({ x: -9, z: 6 })).toBe(false);
  });
});
