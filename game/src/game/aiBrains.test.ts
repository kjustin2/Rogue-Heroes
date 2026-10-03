import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { dist } from "../core/math";

// The three AI brains (2026-09-22). Tier strength was measured once by self-play at equal stats
// (hard beat normal 21-1, normal beat easy 18-5, hard beat easy 22-2 over 24 games each); these are
// the fast, deterministic checks that the HARD behaviours actually fire.
const settleCommand = (sim: TacticalSim): void => { sim.endTurn(); };

describe("hard AI brain", () => {
  it("steps out of a telegraphed barrage instead of standing in it", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    const grunt = sim.debugSpawn("soldier", "enemy", { x: 0, z: 0 });
    grunt.commandPoints = grunt.maxCommandPoints;
    sim.debugSpawn("soldier", "player", { x: -20, z: 8 });
    sim.debugForceEvent("barrage", { x: 0, z: 0, radius: 4 });
    settleCommand(sim);
    const move = sim.orders.find((o) => o.actorId === grunt.id && o.kind === "move");
    expect(move?.destination).toBeDefined();
    expect(dist(move!.destination!, { x: 0, z: 0 })).toBeGreaterThan(4);
  });

  it("finishes the target it can kill this turn before a healthier, pricier one", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    const shooter = sim.debugSpawn("heavy", "enemy", { x: 0, z: 0 });
    shooter.commandPoints = shooter.maxCommandPoints;
    const wounded = sim.debugSpawn("soldier", "player", { x: -8, z: 1 });
    for (const p of wounded.parts) p.hp = Math.min(p.hp, 3);
    const healthy = sim.debugSpawn("sniper", "player", { x: -8, z: -1 }); // higher value, full health
    void healthy;
    settleCommand(sim);
    const shot = sim.orders.find((o) => o.actorId === shooter.id && o.kind === "shoot");
    expect(shot?.targetId).toBe(wounded.id);
  });
});

describe("hard AI brain: posture and posts", () => {
  it("outnumbered, it holds its line near home instead of marching into the player's guns", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    sim.turn = 3;
    const lone = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    lone.commandPoints = lone.maxCommandPoints;
    for (let i = 0; i < 6; i += 1) sim.debugSpawn("tank", "player", { x: -22, z: -10 + i * 3 });
    settleCommand(sim);
    const move = sim.orders.find((o) => o.actorId === lone.id && o.kind === "move");
    // It may step to a better post, but it does not close on the six tanks 30m away.
    expect(!move || move.destination!.x > 2).toBe(true);
  });

  it("pushing in with a pre-assigned post flag off still works (the flags are plain switches)", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    sim.aiX.post = false;
    sim.aiX.posture = false;
    const grunt = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    grunt.commandPoints = grunt.maxCommandPoints;
    sim.debugSpawn("soldier", "player", { x: -22, z: 0 });
    settleCommand(sim);
    const move = sim.orders.find((o) => o.actorId === grunt.id && o.kind === "move");
    expect(move?.destination?.x).toBeLessThan(8);
  });
});
