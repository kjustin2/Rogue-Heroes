import { createBase, createCover, createSoldier, createTank, type CombatEntity } from "./damageModel";

export function createScenario(): CombatEntity[] {
  const sable = createSoldier("p-soldier-2", "Sable", "player", { x: -5.8, z: -4.7 });
  const relayPack = sable.parts.find((part) => part.id === "pack");
  if (relayPack) {
    relayPack.label = "Command Relay";
    relayPack.tags = ["support-aura"];
  }

  return [
    createTank("p-tank-1", "Hammer 1", "player", { x: -8.5, z: 2.5 }),
    createSoldier("p-soldier-1", "Rook", "player", { x: -9, z: -2.5 }),
    sable,

    createTank("e-tank-1", "Breaker", "enemy", { x: 7.8, z: -0.8 }),
    createSoldier("e-soldier-1", "Cutlass", "enemy", { x: 6.3, z: 3.8 }),
    createBase("e-base-1", "Relay Base", "enemy", { x: 10.6, z: -4.2 }),

    createCover("cover-wall-1", "Concrete Wall", { x: -1.8, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-2", "Concrete Wall", { x: 0.2, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-3", "Concrete Wall", { x: 2.2, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-4", "Low Barricade", { x: -1.4, z: -2.6 }, { coverKind: "barricade" }),
    createCover("cover-wall-5", "Low Barricade", { x: 1.4, z: -2.6 }, { coverKind: "barricade" }),
    createCover("fuel-1", "Fuel Cell", { x: 3.8, z: -1.6 }, { coverKind: "fuel", volatile: true }),
    createCover("fuel-2", "Fuel Cell", { x: 5.1, z: -2.1 }, { coverKind: "fuel", volatile: true }),
    createCover("ammo-1", "Ammo Cache", { x: 4.4, z: 1.4 }, { coverKind: "ammo", volatile: true }),
    createCover("conduit-1", "Power Conduit", { x: -3.4, z: 4.6 }, { coverKind: "conduit", volatile: true }),
    createCover("ridge-1", "High Ridge", { x: 1.1, z: 5.3 }, { coverKind: "ridge", hp: 95, radius: 1.35, height: 1.9 }),
  ];
}
