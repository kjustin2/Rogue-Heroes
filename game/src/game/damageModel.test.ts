import { describe, expect, it } from "vitest";
import {
  applyDamage,
  createBase,
  createGrenadier,
  createSniper,
  createSoldier,
  createStriker,
  createTank,
  isInfantryKind,
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

  it("stops a soldier from moving when their legs are destroyed", () => {
    const soldier = createSoldier("soldier", "Rook", "player", { x: 0, z: 0 });

    const result = applyDamage(soldier, "legs", 99);

    expect(result.destroyed).toBe(true);
    expect(soldier.status.alive).toBe(true);
    expect(soldier.status.canMove).toBe(false);
    expect(soldier.status.immobilized).toBe(true);
  });

  it("keeps an economy base unarmed and lets it lose its comms while the core survives", () => {
    const base = createBase("base", "Forward Base", "enemy", { x: 0, z: 0 });

    // A base earns money and deploys troops; it has no weapon and cannot attack.
    expect(base.status.canShoot).toBe(false);
    expect(base.status.canProduce).toBe(true);
    expect(base.parts.some((p) => p.role === "weapon")).toBe(false);

    applyDamage(base, "comms", 80);

    expect(base.status.alive).toBe(true);
    expect(base.status.canShoot).toBe(false);
    expect(base.parts.find((p) => p.id === "core")?.hp).toBe(160);
  });

  it("starts a base with economy state and stops it producing once destroyed", () => {
    const base = createBase("base", "Home Base", "player", { x: 0, z: 0 });

    expect(base.incomeLevel).toBe(0);
    expect(base.unlockedTech).toEqual([]);
    expect(base.status.canProduce).toBe(true);
    expect(base.status.canMove).toBe(false);

    const killed = applyDamage(base, "core", 999);
    expect(killed.killed).toBe(true);
    expect(base.status.alive).toBe(false);
    expect(base.status.canProduce).toBe(false);
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

  it("creates sniper, grenadier, and striker infantry variants with role-specific systems", () => {
    const sniper = createSniper("sniper", "Vesper", "player", { x: 0, z: 0 });
    const grenadier = createGrenadier("grenadier", "Briggs", "player", { x: 0, z: 0 });
    const striker = createStriker("striker", "Kade", "player", { x: 0, z: 0 });

    expect(isInfantryKind(sniper.kind)).toBe(true);
    expect(isInfantryKind(grenadier.kind)).toBe(true);
    expect(isInfantryKind(striker.kind)).toBe(true);
    expect(sniper.parts.find((part) => part.id === "pack")?.tags).toContain("spotter-aura");
    expect(grenadier.parts.find((part) => part.id === "pack")?.role).toBe("volatile");
    expect(striker.parts.find((part) => part.id === "rifle")?.label).toBe("Arc Blade");
    expect(sniper.status.canShoot).toBe(true);
    expect(grenadier.status.canMove).toBe(true);
    expect(striker.status.canShoot).toBe(false);
    expect(striker.status.canMove).toBe(true);
  });

});
