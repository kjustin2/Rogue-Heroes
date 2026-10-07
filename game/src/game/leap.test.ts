import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, pointInWater, setActiveTerrain, terrainHeightAt, terrainWater } from "./terrain";

// EVERY TROOPER CAN HOP (owner 2026-10-03): a short arc over low cover and up onto a ledge; lighter, quicker kinds go farther.

const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal");
  setActiveTerrain(mapDef("dustbowl").terrain); // the map's real ledges and water, not the flat default
  for (const e of sim.entities) if (e.team === "enemy" && e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
  sim.economy.set("enemy", 0);
  return sim;
};

describe("infantry hop", () => {
  it("light, quick kinds jump farther and higher than heavy ones", () => {
    const sim = staged();
    const range = (k: "skater" | "soldier" | "heavy"): number => sim.leapRange(sim.debugSpawn(k, "player", { x: -10, z: 0 }));
    expect(range("skater")).toBeGreaterThan(range("soldier"));
    expect(range("soldier")).toBeGreaterThan(range("heavy"));
    expect(sim.leapUp(sim.debugSpawn("skater", "player", { x: -10, z: 4 }))).toBeGreaterThan(sim.leapUp(sim.debugSpawn("heavy", "player", { x: -10, z: 8 })));
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

describe("infantry hop: robustness", () => {
  it("survives a save / restore with the hop queued, and plays out the same", () => {
    const sim = staged();
    const u = sim.debugSpawn("soldier", "player", { x: -12, z: 0 });
    sim.debugSelect(u.id);
    expect(sim.queueLeap({ x: -9, z: 0 })).toBe(true);
    const copy = new TacticalSim();
    copy.configure(mapDef("dustbowl"), "destroy", "normal");
    copy.restore(sim.serialize());
    const order = copy.orders.find((o) => o.actorId === u.id);
    expect(order?.leap).toBe(true);
    copy.endTurn();
    for (let t = 0; t < 12 && copy.phase === "resolve"; t += 0.05) copy.update(0.05);
    const end = copy.entity(u.id)!;
    expect(end.flying).toBeFalsy();
    expect(Math.hypot(end.position.x + 9, end.position.z)).toBeLessThan(1.3);
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("cancelling a queued hop gives the action point back", () => {
    const sim = staged();
    const u = sim.debugSpawn("soldier", "player", { x: -12, z: 0 });
    sim.debugSelect(u.id);
    sim.queueLeap({ x: -9, z: 0 });
    const id = sim.orders.find((o) => o.actorId === u.id)!.id;
    sim.cancelOrder(id);
    expect(u.commandPoints).toBe(u.maxCommandPoints);
    expect(sim.orders.some((o) => o.actorId === u.id)).toBe(false);
  });

  it("landing on a spot someone else took slides clear: two bodies never overlap", () => {
    const sim = staged();
    const a = sim.debugSpawn("soldier", "player", { x: -12, z: 0 });
    sim.debugSelect(a.id);
    expect(sim.queueLeap({ x: -9, z: 0 })).toBe(true);
    const b = sim.debugSpawn("soldier", "player", { x: -9, z: 0.1 });
    b.commandPoints = 0;
    sim.endTurn();
    for (let t = 0; t < 12 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    const A = sim.entity(a.id)!;
    const B = sim.entity(b.id)!;
    expect(Math.hypot(A.position.x - B.position.x, A.position.z - B.position.z)).toBeGreaterThanOrEqual(A.radius + B.radius - 0.05);
    expect(A.flying).toBeFalsy();
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("a hop across water lands on the far bank and never in the river", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("karak"), "destroy", "normal");
    setActiveTerrain(mapDef("karak").terrain);
    const river = terrainWater()[0]!; // the live map is scaled, so read the real ravine
    const z = (river.minZ + river.maxZ) / 2 + 3.2; // clear of the bridge spans
    const west = { x: river.minX - 0.9, z };
    const east = { x: river.maxX + 0.9, z };
    const u = sim.debugSpawn("skater", "player", west);
    sim.debugSelect(u.id);
    const gap = east.x - west.x;
    expect(gap).toBeLessThan(sim.leapRange(u)); // the ravine is a hop wide
    const hop = sim.leapPreview(east)!;
    expect(hop.ok, hop.reason).toBe(true);
    expect(sim.queueLeap(east)).toBe(true);
    sim.endTurn();
    for (let t = 0; t < 12 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    const end = sim.entity(u.id)!;
    expect(end.flying).toBeFalsy();
    expect(pointInWater(end.position)).toBe(false);
    expect(end.position.x).toBeGreaterThan(river.maxX);
    // aiming INTO the river never lands in it: the landing slides to a bank or the hop is refused
    const wet = sim.leapPreview({ x: (river.minX + river.maxX) / 2, z })!;
    expect(pointInWater(wet.to)).toBe(false);
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("a hop up onto a low ledge lands standing on it, at the ledge's height", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("karak"), "destroy", "normal");
    setActiveTerrain(mapDef("karak").terrain);
    let found: { low: { x: number; z: number }; high: { x: number; z: number } } | undefined;
    for (let x = -40; x < 40 && !found; x += 0.5) for (let z = -20; z < 20 && !found; z += 0.5) {
      const high = { x, z };
      const low = { x: x - 2.5, z };
      const h = terrainHeightAt(high);
      if (h >= 0.6 && h <= 0.95 && terrainHeightAt(low) === 0 && !pointInWater(low) && !pointInWater(high)) found = { low, high };
    }
    expect(found, "karak has a low ledge to hop onto").toBeDefined();
    const u = sim.debugSpawn("skater", "player", found!.low);
    sim.debugSelect(u.id);
    const hop = sim.leapPreview(found!.high)!;
    expect(hop.ok, hop.reason).toBe(true);
    expect(sim.queueLeap(found!.high)).toBe(true);
    sim.endTurn();
    for (let t = 0; t < 12 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    const end = sim.entity(u.id)!;
    expect(end.flying).toBeFalsy();
    expect(end.elevation).toBeGreaterThan(0.5);
    expect(Math.abs(end.elevation - terrainHeightAt(end.position))).toBeLessThan(0.05);
    setActiveTerrain(DEFAULT_TERRAIN);
  });
});
