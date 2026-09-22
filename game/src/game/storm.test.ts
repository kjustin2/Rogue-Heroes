import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { dist } from "../core/math";

const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((sum, p) => sum + p.hp, 0);

describe("lightning storm (item 14)", () => {
  it("telegraphs a point during command and strikes exactly there during resolve", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("verdant"), "destroy", "normal");
    // Verdant's storm starts on turn 4; jump ahead.
    while (sim.turn < 4) { sim.endTurn(); settle(sim); }
    const zones = sim.eventZonesForTurn();
    const bolt = zones.find((z) => z.kind === "lightning");
    expect(bolt).toBeDefined();
    expect(sim.environment().notice).toMatch(/Lightning/);
    // Stand a pinned trooper on the mark, and one well away from it.
    const victim = sim.debugSpawn("heavy", "player", { x: bolt!.x, z: bolt!.z });
    const safe = sim.debugSpawn("heavy", "player", { x: bolt!.x + 9, z: bolt!.z });
    for (const e of [victim, safe]) { for (const p of e.parts) if (p.role === "mobility") p.hp = 0; e.status.canMove = false; }
    const v0 = hp(victim);
    const s0 = hp(safe);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("Lightning strikes"))).toBe(true);
    expect(hp(victim)).toBeLessThan(v0);
    expect(hp(safe)).toBe(s0);
    // Next turn the mark moves.
    const next = sim.eventZonesForTurn().find((z) => z.kind === "lightning")!;
    expect(dist(next, bolt!)).toBeGreaterThan(1);
  });
});

describe("chain reactions (item 12)", () => {
  it("one fuel cell going up takes its neighbour with it", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    const a = sim.debugCover("fuel", { x: 0, z: 0 });
    const b = sim.debugCover("fuel", { x: 2.4, z: 0 });
    const shooter = sim.debugSpawn("soldier", "player", { x: -8, z: 0 });
    sim.debugDamage(a.id, a.parts[0].id, 999, shooter.id);
    expect(a.status.alive).toBe(false);
    expect(b.status.alive).toBe(false);
    expect(sim.burnZones.length).toBe(2);
  });
});

describe("slag spill (Ironworks' own event)", () => {
  it("telegraphs a furnace corner, floods it with a burning zone, and alternates corners", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("ironworks"), "destroy", "normal");
    while (sim.turn < 3) { sim.endTurn(); settle(sim); }
    const spill = sim.eventZonesForTurn().find((z) => z.kind === "slag");
    expect(spill).toBeDefined();
    expect(sim.environment().notice).toMatch(/Slag/);
    const victim = sim.debugSpawn("heavy", "player", { x: spill!.x, z: spill!.z });
    for (const p of victim.parts) if (p.role === "mobility") p.hp = 0;
    victim.status.canMove = false;
    const v0 = hp(victim);
    sim.endTurn();
    settle(sim);
    expect(hp(victim)).toBeLessThan(v0);
    expect(sim.burnZones.some((z) => dist(z, spill!) < 0.1)).toBe(true);
    // The next spill (turn 6) floods the OTHER furnace.
    const next = sim.eventZonesForTurn(6).find((z) => z.kind === "slag")!;
    expect(next.x).toBeCloseTo(-spill!.x);
    expect(next.z).toBeCloseTo(-spill!.z);
  });
});
