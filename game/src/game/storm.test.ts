import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { dist } from "../core/math";
import { nearestDryPoint } from "./terrain";

const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((sum, p) => sum + p.hp, 0);

// LANE HAZARDS (2026-10-07: replace the sandstorm, the ion storm, the lightning and the collapse). Each one is warned a turn
// early (a "soon" lane on the ground), sweeps its lanes on its turn, throws every trooper it reaches off the lane, never moves a
// heavy, and its lanes are point-symmetric so neither seat is favoured.
describe("lane hazards", () => {
  const MAPS_WITH = { dustbowl: "devil", verdant: "stampede", karak: "boulder", causeway: "icebreaker" } as const;
  for (const [id, kind] of Object.entries(MAPS_WITH)) {
    it(`${id}: the ${kind} is warned a turn early, then sweeps its lane and throws a trooper off it`, () => {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      const lane = sim.mapDef.lanes![0];
      while (sim.turn < lane.startTurn - 1) { sim.endTurn(); settle(sim); }
      expect(sim.environment().lanes.some((l) => l.kind === kind && l.state === "soon"), "warned the turn before").toBe(true);
      sim.endTurn(); settle(sim);
      expect(sim.turn).toBe(lane.startTurn);
      const line = sim.lanesOn()[0];
      expect(line.kind).toBe(kind);
      // A PLAYER trooper (the enemy AI would walk its own off) on the lane's midpoint, on dry ground.
      const mid = { x: (line.from.x + line.to.x) / 2, z: (line.from.z + line.to.z) / 2 };
      const at = kind === "icebreaker" ? mid : nearestDryPoint(mid);
      const victim = sim.debugSpawn("soldier", "player", at);
      for (const p of victim.parts) { p.maxHp *= 5; p.hp = p.maxHp; }
      const before = victim.parts.reduce((s2, p) => s2 + p.hp, 0);
      const start = { ...victim.position };
      sim.endTurn(); settle(sim);
      const after = sim.entity(victim.id)!;
      expect(after.parts.reduce((s2, p) => s2 + p.hp, 0), "hit").toBeLessThan(before);
      expect(Math.hypot(after.position.x - start.x, after.position.z - start.z), "thrown off the lane").toBeGreaterThan(1);
    });
  }

  it("every lane is point-symmetric with its partner (or crosses the centre), so neither seat is favoured", () => {
    for (const id of ["dustbowl", "verdant", "karak", "causeway"]) {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      const lane = sim.mapDef.lanes![0];
      const lines = sim.lanesOn(lane.startTurn);
      const c = { x: 0, z: 0 };
      const mirrored = (a: { x: number; z: number }) => ({ x: 2 * c.x - a.x, z: 2 * c.z - a.z });
      for (const l of lines) {
        const m = { from: mirrored(l.from), to: mirrored(l.to) };
        const twin = lines.some((o) => Math.hypot(o.from.x - m.to.x, o.from.z - m.to.z) < 0.6 && Math.hypot(o.to.x - m.from.x, o.to.z - m.from.z) < 0.6)
          || lines.some((o) => Math.hypot(o.from.x - m.from.x, o.from.z - m.from.z) < 0.6 && Math.hypot(o.to.x - m.to.x, o.to.z - m.to.z) < 0.6);
        expect(twin, `${id} lane has a mirror twin`).toBe(true);
      }
    }
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
  it("telegraphs BOTH furnace corners, floods them with burning zones, on every spill", () => {
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
    // Mirror-symmetric: each spill floods both furnaces (alternating corners handed the enemy seat
    // Ironworks 13-1 in balance self-play), and so does the next one.
    for (const turn of [3, 6]) {
      const zones = sim.eventZonesForTurn(turn).filter((z) => z.kind === "slag");
      expect(zones.length).toBe(2);
      expect(zones[1].x).toBeCloseTo(-zones[0].x);
      expect(zones[1].z).toBeCloseTo(-zones[0].z);
    }
  });
});
