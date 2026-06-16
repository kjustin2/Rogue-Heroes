import { describe, expect, it } from "vitest";
import {
  applyDamage,
  createBase,
  createSoldier,
  createTank,
  preferredPart,
  repairForNewTurn,
  vulnerabilityMultiplier,
} from "./damageModel";

describe("component damage model", () => {
  it("immobilizes a tank when a tread is destroyed", () => {
    const tank = createTank("tank", "Hammer", "player", { x: 0, z: 0 });

    const result = applyDamage(tank, "left-tread", 99);

    expect(result.destroyed).toBe(true);
    expect(tank.status.alive).toBe(true);
    expect(tank.status.canMove).toBe(false);
    expect(tank.status.immobilized).toBe(true);
    expect(tank.status.canShoot).toBe(true);
  });

  it("disarms a soldier when the rifle is destroyed without killing them", () => {
    const soldier = createSoldier("soldier", "Rook", "player", { x: 0, z: 0 });

    const result = applyDamage(soldier, "rifle", 25);

    expect(result.destroyed).toBe(true);
    expect(soldier.status.alive).toBe(true);
    expect(soldier.status.canShoot).toBe(false);
    expect(soldier.status.disarmed).toBe(true);
  });

  it("kills a soldier instantly when the head is destroyed", () => {
    const soldier = createSoldier("soldier", "Rook", "player", { x: 0, z: 0 });

    const result = applyDamage(soldier, "head", 99);

    expect(result.killed).toBe(true);
    expect(soldier.status.alive).toBe(false);
    expect(soldier.status.deadReason).toBe("Head");
  });

  it("lets a base lose its turret while the command core survives", () => {
    const base = createBase("base", "Forward Base", "enemy", { x: 0, z: 0 });

    applyDamage(base, "turret", 80);

    expect(base.status.alive).toBe(true);
    expect(base.status.canShoot).toBe(false);
    expect(base.parts.find((p) => p.id === "core")?.hp).toBe(150);
  });

  it("jams tank fire when the turret ring is destroyed", () => {
    const tank = createTank("tank", "Hammer", "player", { x: 0, z: 0 });

    applyDamage(tank, "turret", 99);

    expect(tank.status.alive).toBe(true);
    expect(tank.status.canShoot).toBe(false);
    expect(tank.status.disarmed).toBe(true);
    expect(tank.status.systemsDown).toContain("Turret Ring");
  });

  it("limits command points when utility packs are destroyed", () => {
    const soldier = createSoldier("soldier", "Rook", "player", { x: 0, z: 0 });

    applyDamage(soldier, "pack", 99);
    repairForNewTurn(soldier);

    expect(soldier.status.commandLimited).toBe(true);
    expect(soldier.commandPoints).toBe(1);
  });

  it("makes core shots hit harder after armor is stripped", () => {
    const tank = createTank("tank", "Hammer", "enemy", { x: 0, z: 0 });
    const hull = tank.parts.find((p) => p.id === "hull");

    expect(hull).toBeDefined();
    expect(vulnerabilityMultiplier(tank, hull!)).toBe(1);
    applyDamage(tank, "front-plate", 99);

    expect(tank.status.exposedCore).toBe(true);
    expect(vulnerabilityMultiplier(tank, hull!)).toBeGreaterThan(1);
  });

  it("aims at gameplay-specific parts before center mass", () => {
    const tank = createTank("tank", "Hammer", "enemy", { x: 0, z: 0 });

    expect(preferredPart(tank, "mobility").id).toBe("left-tread");
    expect(preferredPart(tank, "weapon").id).toBe("cannon");
    expect(preferredPart(tank, "utility").id).toBe("turret");
    expect(preferredPart(tank, "core").id).toBe("hull");
  });
});
