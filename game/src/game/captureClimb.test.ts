import { describe, expect, it } from "vitest";
import { applyDamage, createBase, createSoldier, createTurret } from "./damageModel";
import { TacticalSim } from "./sim";
import { climbsAlong } from "./terrain";

const resolve = (sim: TacticalSim): void => {
  sim.endTurn();
  for (let guard = 0; sim.phase === "resolve" && guard < 400; guard += 1) sim.update(0.05);
};

describe("derelict turret capture (owner 2026-09-23: 'take control of it to fire with it')", () => {
  it("a unit beside it flips it, renames it, and from the next turn the player can order it to shoot", () => {
    const turret = createTurret("nt-1", "Derelict Turret", "neutral", { x: 3, z: 0 });
    turret.capturable = true;
    turret.commandPoints = 0;
    const grunt = createSoldier("p-g", "Grunt", "player", { x: 1.6, z: 0 });
    const foe = createSoldier("e-f", "Foe", "enemy", { x: 9, z: 0 });
    applyDamage(foe, "rifle", 999); // disarmed so it can't kill the grunt mid-test
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -14, z: 0 }),
      createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 }),
      grunt, turret, foe,
    ]);
    resolve(sim);
    expect(turret.team).toBe("player");
    expect(turret.name).toBe("Captured Turret");
    expect(sim.log.some((l) => l.includes("select it next turn to fire it"))).toBe(true);

    resolve(sim); // comes online
    expect(turret.commandPoints).toBeGreaterThan(0);
    sim.select(turret.id);
    expect(sim.queueShoot(foe.id)).toBe(true);
  });

  it("Tab reaches a turret you own", () => {
    const turret = createTurret("t-1", "Gun Turret", "player", { x: 3, z: 0 });
    const grunt = createSoldier("p-g", "Grunt", "player", { x: 0, z: 0 });
    const sim = new TacticalSim([grunt, turret]);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) { sim.cyclePlayer(1); seen.add(sim.selectedId); }
    expect(seen.has(turret.id)).toBe(true);
  });
});

describe("climbsAlong (the ▲ CLIMB move cue)", () => {
  // DEFAULT_TERRAIN has a mesa whose face sits at z = 3.8.
  it("marks the step up onto the mesa, and nothing coming back down", () => {
    new TacticalSim([]); // resets to DEFAULT_TERRAIN
    const up = climbsAlong({ x: 2, z: 0 }, { x: 2, z: 6 });
    expect(up.length).toBe(1);
    expect(up[0].rise).toBeGreaterThan(0.3);
    expect(up[0].point.z).toBeGreaterThan(3.6);
    expect(climbsAlong({ x: 2, z: 6 }, { x: 2, z: 0 })).toEqual([]);
    expect(climbsAlong({ x: -2, z: 0 }, { x: 2, z: 0 })).toEqual([]); // flat ground
  });
});
