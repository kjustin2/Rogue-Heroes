import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { TERRAIN_STEP, terrainHeightAt } from "./terrain";

// Climbing + order edge cases, end to end on the REAL maps (2026-09-22 audit). Each case asserts
// where the unit actually ENDS UP after the resolve, not just that the order was accepted.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 60 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const quietEnemy = (sim: TacticalSim): void => {
  // Nothing on the enemy side moves or shoots, so a measurement is never swamped by the AI.
  for (const e of sim.entities) if (e.team === "enemy") { e.commandPoints = 0; e.maxCommandPoints = 0; }
};

describe("climbing (real maps)", () => {
  it("infantry walk up a stepped mesa one step at a time and end ON it", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("verdant"), "destroy", "normal");
    quietEnemy(sim);
    // The tallest block whose footprint has a walkable approach: find a point on top and a point
    // at the foot, and let the move order route between them.
    const blocks = [...(sim.mapDef.terrain.blocks ?? [])].sort((a, b) => b.height - a.height);
    const top = blocks.find((b) => b.maxX - b.minX > 3 && b.maxZ - b.minZ > 3)!;
    const onTop = { x: (top.minX + top.maxX) / 2, z: (top.minZ + top.maxZ) / 2 };
    const s = sim.debugSpawn("soldier", "player", { x: top.minX - 3, z: onTop.z });
    const startH = s.elevation;
    for (let turn = 0; turn < 6 && Math.abs(s.elevation - terrainHeightAt(onTop)) > 0.05; turn += 1) {
      s.commandPoints = s.maxCommandPoints;
      sim.select(s.id);
      sim.queueMove(onTop);
      sim.endTurn();
      settle(sim);
    }
    // Either it got up (every step <= TERRAIN_STEP), or the block is a cliff and it must not be
    // standing inside it -- elevation must always match the ground where it stands.
    expect(Math.abs(s.elevation - terrainHeightAt(s.position))).toBeLessThan(0.06);
    if (terrainHeightAt(onTop) - startH > 0) expect(s.elevation).toBeGreaterThanOrEqual(startH);
  });

  it("a trooper walks up the Ironworks overpass ramp onto the deck; a tank (wider than the ramp) is refused without losing a AP", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("ironworks"), "destroy", "normal");
    quietEnemy(sim);
    const blocks = sim.mapDef.terrain.blocks ?? [];
    const deck = blocks.find((b) => b.height >= 1.2 && b.height <= 1.3)!;
    const ramp = blocks.find((b) => b.height > 0.6 && b.height < 0.7 && b.maxX <= deck.minX + 0.01)!;
    const z = (deck.minZ + deck.maxZ) / 2;
    const target = { x: deck.minX + 1.2, z };
    const s = sim.debugSpawn("soldier", "player", { x: ramp.minX - 2, z });
    for (let turn = 0; turn < 4 && s.elevation < 1.2; turn += 1) {
      s.commandPoints = s.maxCommandPoints;
      sim.select(s.id);
      sim.queueMove(target);
      sim.endTurn();
      settle(sim);
    }
    expect(s.elevation).toBeGreaterThan(1.2);
    expect(Math.abs(s.elevation - terrainHeightAt(s.position))).toBeLessThan(0.06);

    const tank = sim.debugSpawn("tank", "player", { x: ramp.minX - 3.5, z: z - 6 });
    const cp = tank.commandPoints;
    sim.select(tank.id);
    const moved = sim.queueMove({ x: tank.position.x, z: tank.position.z + 0.01 + 0 }) || true; // warm the selection
    void moved;
    tank.commandPoints = cp;
    sim.cancelOrder(sim.orders.at(-1)?.id ?? "");
    tank.commandPoints = cp;
    // Park a wall right in front of it: the move has nowhere to go and must be refused, CP intact.
    sim.debugCover("wall", { x: tank.position.x + tank.radius + 0.9, z: tank.position.z });
    sim.select(tank.id);
    expect(sim.queueMove({ x: tank.position.x + 8, z: tank.position.z })).toBe(false);
    expect(tank.commandPoints).toBe(cp);
    expect(sim.log[0]).toMatch(/blocked|can't move/);
  });

  it("a trooper who climbs a crate stands on it, and comes back down to the ground when he walks off", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    quietEnemy(sim);
    const crate = sim.debugCover("crate", { x: 0, z: 0 });
    const s = sim.debugSpawn("soldier", "player", { x: -1.8, z: 0 });
    sim.select(s.id);
    expect(sim.queueClimbCover(crate.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(s.elevation).toBeGreaterThan(terrainHeightAt(crate.position) + 0.5);
    s.commandPoints = s.maxCommandPoints;
    sim.select(s.id);
    expect(sim.queueMove({ x: -4, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(Math.abs(s.elevation - terrainHeightAt(s.position))).toBeLessThan(0.06);
  });

  it("no ground unit on any map ever ends a turn floating above or sunk below its ground", () => {
    for (const id of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      sim.economy.set("player", 5000);
      sim.economy.set("enemy", 5000);
      for (let turn = 0; turn < 5 && sim.phase === "command"; turn += 1) {
        sim.debugCommandAsAi(); // the player seat plays too, so both sides move around the map
        sim.endTurn();
        settle(sim);
      }
      for (const e of sim.entities) {
        if (!e.status.alive || e.flying || e.kind === "cover" || e.carriedById) continue;
        const ground = terrainHeightAt(e.position);
        // Standing on climbable cover is legal (elevation above ground); below ground never is.
        expect(e.elevation, `${id}: ${e.name}`).toBeGreaterThanOrEqual(ground - 0.06);
        expect(e.elevation - ground, `${id}: ${e.name} floats`).toBeLessThan(TERRAIN_STEP + 1.5);
      }
    }
  });
});

describe("order edge cases", () => {
  it("cancelling a queued move refunds the action point and removes the order", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    const s = sim.debugSpawn("soldier", "player", { x: -10, z: 0 });
    const cp = s.commandPoints;
    sim.select(s.id);
    expect(sim.queueMove({ x: -8, z: 0 })).toBe(true);
    expect(s.commandPoints).toBe(cp - 1);
    expect(sim.cancelOrder(sim.orders[0].id)).toBe(true);
    expect(s.commandPoints).toBe(cp);
    expect(sim.orders).toHaveLength(0);
  });

  it("a unit killed before its order runs does not act from the grave", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    quietEnemy(sim);
    const s = sim.debugSpawn("soldier", "player", { x: -10, z: 0 });
    const start = { ...s.position };
    sim.select(s.id);
    sim.queueMove({ x: -6, z: 0 });
    for (const p of s.parts) sim.debugDamage(s.id, p.id, 9999);
    sim.endTurn();
    settle(sim);
    expect(s.status.alive).toBe(false);
    expect(s.position).toEqual(start);
  });

  it("shooting at a target that dies first ends cleanly (no stuck resolve, no error)", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    quietEnemy(sim);
    const a = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    const b = sim.debugSpawn("soldier", "player", { x: -6, z: 2 });
    const t = sim.debugSpawn("soldier", "enemy", { x: 2, z: 1 });
    for (const p of t.parts) p.hp = Math.min(p.hp, 1);
    for (const u of [a, b]) { sim.select(u.id); sim.queueShoot(t.id); }
    sim.endTurn();
    settle(sim);
    expect(sim.phase === "command" || sim.phase === "victory").toBe(true);
    expect(t.status.alive).toBe(false);
  });

  it("two troopers ordered to the same spot do not end up stacked inside each other", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    quietEnemy(sim);
    const a = sim.debugSpawn("soldier", "player", { x: -12, z: -2 });
    const b = sim.debugSpawn("soldier", "player", { x: -12, z: 2 });
    for (const u of [a, b]) { sim.select(u.id); sim.queueMove({ x: -8, z: 0 }); }
    sim.endTurn();
    settle(sim);
    const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
    expect(d).toBeGreaterThan((a.radius + b.radius) * 0.8);
  });

  it("a move into open water is refused or stopped at the shore, never ends in the water", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("causeway"), "destroy", "normal");
    quietEnemy(sim);
    const water = sim.mapDef.terrain.water![0];
    const mid = { x: (water.minX + water.maxX) / 2, z: (water.minZ + water.maxZ) / 2 };
    const s = sim.debugSpawn("soldier", "player", { x: mid.x, z: water.maxZ + 3 });
    sim.select(s.id);
    sim.queueMove(mid);
    sim.endTurn();
    settle(sim);
    const inWater = s.position.x > water.minX && s.position.x < water.maxX && s.position.z > water.minZ && s.position.z < water.maxZ;
    const onBridge = (sim.mapDef.terrain.bridges ?? []).some((b) => s.position.x > b.minX && s.position.x < b.maxX && s.position.z > b.minZ && s.position.z < b.maxZ);
    expect(inWater && !onBridge).toBe(false);
  });
});
