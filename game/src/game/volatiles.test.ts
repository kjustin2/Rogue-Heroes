import { describe, expect, it } from "vitest";
import { createBase, createCover, createSoldier, createTurret, type CombatEntity } from "./damageModel";
import { TacticalSim } from "./sim";

// The three volatile props used to detonate identically, so "fuel cell", "ammo cache" and "power
// conduit" were three names for one event and there was never a reason to prefer shooting one.
// These assert each now does something the others do not -- which is the whole point of having
// three of them.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};

/** Blow up a volatile prop by destroying its volatile part directly. */
const rupture = (sim: TacticalSim, prop: CombatEntity): void => {
  const shooter = sim.entities.find((e) => e.team === "player" && e.kind === "soldier");
  const fuse = prop.parts.find((p) => p.role === "volatile");
  expect(fuse, "prop has no volatile part").toBeDefined();
  // One rifle round does not reliably finish a fuel cell, and this test is about what happens AFTER
  // the rupture, not about how many shots it takes. Leave the fuse on its last hit point.
  fuse!.hp = 1;
  sim.select(shooter!.id);
  expect(sim.queueShootPart(prop.id, fuse!.id), "could not target the volatile part").toBe(true);
  sim.endTurn();
  settle(sim);
  expect(fuse!.hp, "the shot never destroyed the fuse").toBe(0);
};

const staged = (coverKind: "fuel" | "ammo" | "conduit", extra: CombatEntity[] = []) => {
  const shooter = createSoldier("p1", "Rifleman", "player", { x: -3, z: 0 });
  const prop = createCover("prop", "Volatile", { x: 2, z: 0 }, { coverKind, volatile: true });
  // A surviving enemy well out of the way. Without one the battle is already won, the phase goes
  // straight to victory, and the turn counter stops -- which silently breaks any test that waits
  // for something to expire over several rounds.
  const foe = createBase("e-base", "Enemy HQ", "enemy", { x: 24, z: 14 });
  const sim = new TacticalSim([shooter, prop, foe, ...extra]);
  return { sim, prop, shooter };
};

describe("volatile props each do something different", () => {
  it("a ruptured fuel cell leaves a fire burning after the blast", () => {
    const { sim, prop } = staged("fuel");
    expect(sim.burnZones.length).toBe(0);
    rupture(sim, prop);
    // The bang is the small part; the denial is the point, and it outlasts the turn.
    expect(sim.burnZones.length, "fuel left no fire").toBeGreaterThan(0);
    expect(sim.burnZones[0].turnsLeft).toBeGreaterThan(1);
  });

  it("an ammo cache cooks off instead of leaving a fire", () => {
    const { sim, prop } = staged("ammo");
    rupture(sim, prop);
    expect(sim.burnZones.length, "ammo should not start a lasting fire").toBe(0);
  });

  it("a cut conduit blacks out nearby emplacements without destroying them", () => {
    const turret = createTurret("t1", "Gun Turret", "player", { x: 4, z: 0 });
    const { sim, prop } = staged("conduit", [turret]);
    expect(sim.isPowerCut(turret)).toBe(false);
    rupture(sim, prop);

    const live = sim.entities.find((e) => e.id === "t1")!;
    // Blacked out, NOT blown up: it keeps its armour and its footprint, so it is still cover and
    // still in the way. It simply cannot shoot.
    expect(live.status.alive, "the conduit should not destroy the turret").toBe(true);
    expect(sim.isPowerCut(live), "turret still has power after the conduit was cut").toBe(true);
    // And the refusal is explicit rather than a silent no-op.
    sim.select(live.id);
    const enemy = sim.entities.find((e) => e.team === "player" && e.kind === "soldier")!;
    expect(sim.queueShoot(enemy.id), "a blacked-out turret still accepted a shoot order").toBe(false);
  });

  it("power comes back on its own", () => {
    const turret = createTurret("t1", "Gun Turret", "player", { x: 4, z: 0 });
    const { sim, prop } = staged("conduit", [turret]);
    rupture(sim, prop);
    const live = sim.entities.find((e) => e.id === "t1")!;
    expect(sim.isPowerCut(live)).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      sim.endTurn();
      settle(sim);
    }
    expect(sim.isPowerCut(live), "the outage never ended").toBe(false);
  });

  it("an outage survives a save and reload", () => {
    // poweredUntilTurn rides on the entity, so it round-trips with everything else -- but that is
    // exactly the kind of assumption that is worth checking rather than believing.
    const turret = createTurret("t1", "Gun Turret", "player", { x: 4, z: 0 });
    const { sim, prop } = staged("conduit", [turret]);
    rupture(sim, prop);
    const saved = sim.serialize();
    const fresh = new TacticalSim([]);
    expect(fresh.restore(saved)).toBe(true);
    const restored = fresh.entities.find((e) => e.id === "t1")!;
    expect(fresh.isPowerCut(restored)).toBe(true);
  });
});
