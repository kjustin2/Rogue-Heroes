import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { TERRAIN_STEP, terrainBlocks, terrainHeightAt } from "./terrain";
import type { Vec2 } from "../core/math";

// The jump trooper's whole point is VERTICAL movement: a move that arcs over a cliff a walker
// would stop at, and lands on top. Frozen Causeway's bergs are 2.4 tall on flat ground -- a real
// cliff (> TERRAIN_STEP), found here by measurement so the test cannot rot with the map data.
const cliff = (): { top: Vec2; foot: Vec2 } => {
  for (const b of terrainBlocks()) {
    const top = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
    const foot = { x: b.minX - 3, z: top.z };
    if (b.height > TERRAIN_STEP + 0.5 && terrainHeightAt(foot) === 0 && terrainHeightAt(top) === b.height) return { top, foot };
  }
  throw new Error("no cliff on this map");
};
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};

const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("causeway"), "destroy", "normal");
  return sim;
};

describe("jump trooper", () => {
  it("lands on top of a cliff a walker cannot climb, and is on the ground when it lands", () => {
    const sim = staged();
    const { top: hilltop, foot: start } = cliff();
    const walker = sim.debugSpawn("soldier", "player", start);
    sim.debugSelect(walker.id);
    expect(sim.queueMove(hilltop)).toBe(true);
    const jumper = sim.debugSpawn("jumper", "player", { x: start.x, z: start.z + 1.5 });
    sim.debugSelect(jumper.id);
    expect(sim.queueMove({ x: hilltop.x, z: hilltop.z + 1 })).toBe(true);
    sim.endTurn();
    settle(sim);

    expect(sim.phase).toBe("command");
    expect(jumper.flying).toBeFalsy();
    expect(jumper.agl).toBeUndefined();
    expect(Math.abs(jumper.position.x - hilltop.x)).toBeLessThan(0.5);
    expect(jumper.elevation).toBeCloseTo(terrainHeightAt(jumper.position), 1);
    expect(jumper.elevation).toBeGreaterThan(1);
    // The walker was stopped short of the summit by the cliff.
    expect(walker.elevation).toBeLessThan(jumper.elevation);
  });

  it("is airborne mid-leap", () => {
    const sim = staged();
    const { top, foot } = cliff();
    const jumper = sim.debugSpawn("jumper", "player", foot);
    sim.debugSelect(jumper.id);
    expect(sim.queueMove(top)).toBe(true);
    sim.endTurn();
    let peak = 0;
    for (let t = 0; t < 3 && sim.phase === "resolve"; t += 0.05) {
      sim.update(0.05);
      if (jumper.flying) peak = Math.max(peak, jumper.agl ?? 0);
    }
    expect(peak).toBeGreaterThan(1);
  });

  it("stops jumping once its pack is destroyed", () => {
    const sim = staged();
    const { top, foot } = cliff();
    const jumper = sim.debugSpawn("jumper", "player", foot);
    const pack = jumper.parts.find((p) => p.id === "pack")!;
    pack.hp = 0;
    sim.debugSelect(jumper.id);
    expect(sim.queueMove(top)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(jumper.elevation).toBeLessThan(1); // walked, and the cliff stopped it
  });
});
