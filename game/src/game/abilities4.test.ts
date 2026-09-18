import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round four (docs/unit-identity-ideas.md picks 5, 9, 10, 14, 15, 17, 18):
// grenadier AIRBURST, flamer FEAR, drone op RECON, APC CARRY, artillery DEPLOY, gunship STRAFE,
// bomber CARPET.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); return sim; };
// The enemy AI moves and shoots its units during the resolve; take their legs and weapon so the
// staging stays where it was put.
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);

describe("grenadier airburst", () => {
  it("a round that bursts on cover still lands half its damage on the trooper behind it", () => {
    const sim = staged();
    const grenadier = sim.debugSpawn("grenadier", "player", { x: -18, z: 0 });
    const wall = sim.debugCover("pillar", { x: 0, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: wall.radius + 0.8, z: 0 });
    disarm(target);
    target.stance = "crouched";
    const before = hp(target);
    sim.debugSelect(grenadier.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("bursts near Stone Pillar"))).toBe(true); // the round DID hit the wall
    expect(sim.log.some((l) => l.includes("airbursts"))).toBe(true);
    expect(before - hp(target)).toBeGreaterThanOrEqual(12);
  });
});

describe("flamer fear", () => {
  it("enemy infantry beside burning ground run from it, where the same trooper otherwise advances through it", () => {
    const run = (burning: boolean): number => {
      const sim = staged();
      const bait = sim.debugSpawn("soldier", "player", { x: -14, z: 0 });
      disarm(bait);
      const trooper = sim.debugSpawn("soldier", "enemy", { x: 4, z: 0 });
      // The fire sits between the trooper and the player, 3m out (FLAMER_FEAR_RADIUS is 6).
      if (burning) sim.burnZones.push({ id: "burn-test", x: 1, z: 0, radius: 1.6, turnsLeft: 3 });
      sim.endTurn();
      settle(sim);
      expect(sim.log.some((l) => l.includes("runs from the fire"))).toBe(burning);
      return trooper.position.x;
    };
    expect(run(true)).toBeGreaterThan(6); // fled away from the flames (+x)
    expect(run(false)).toBeLessThan(2); // control: pressed the player (-x), straight past the spot
  });
});
