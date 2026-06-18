import { createBase, createCover, createGrenadier, createSniper, createSoldier, createStriker, createTank, type CombatEntity } from "./damageModel";

export function createScenario(): CombatEntity[] {
  const sable = createSoldier("p-soldier-2", "Sable", "player", { x: -5.8, z: -4.7 });
  const relayPack = sable.parts.find((part) => part.id === "pack");
  if (relayPack) {
    relayPack.label = "Command Relay";
    relayPack.tags = ["support-aura"];
  }

  return [
    createTank("p-tank-1", "Hammer 1", "player", { x: -12.6, z: 1.8 }),
    createSoldier("p-soldier-1", "Rook", "player", { x: -12.3, z: -3.2 }),
    sable,
    createSniper("p-sniper-1", "Vesper", "player", { x: -10.9, z: 5.6 }),
    createGrenadier("p-grenadier-1", "Briggs", "player", { x: -10.5, z: -7.2 }),
    createStriker("p-striker-1", "Kade", "player", { x: -13.9, z: -6.4 }),

    createTank("e-tank-1", "Breaker", "enemy", { x: 11.7, z: -0.9 }),
    createSoldier("e-soldier-1", "Cutlass", "enemy", { x: 9.2, z: 4.2 }),
    createSniper("e-sniper-1", "Kestrel", "enemy", { x: 12.4, z: 6.4 }),
    createGrenadier("e-grenadier-1", "Mallet", "enemy", { x: 8.8, z: -6.5 }),
    createBase("e-base-1", "Relay Base", "enemy", { x: 14.4, z: -4.8 }),

    createCover("cover-wall-1", "Sandcrete Wall", { x: -3.8, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-2", "Sandcrete Wall", { x: -1.7, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-3", "Sandcrete Wall", { x: 0.4, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-4", "Sandcrete Wall", { x: 2.5, z: 2.8 }, { coverKind: "wall" }),
    createCover("cover-wall-5", "Low Stone Barricade", { x: -4.6, z: -3.1 }, { coverKind: "barricade" }),
    createCover("cover-wall-6", "Low Stone Barricade", { x: -2.1, z: -3.2 }, { coverKind: "barricade" }),
    createCover("cover-wall-7", "Low Stone Barricade", { x: 2.2, z: -3.2 }, { coverKind: "barricade" }),
    createCover("cover-wall-8", "Low Stone Barricade", { x: 5.2, z: -3.8 }, { coverKind: "barricade" }),
    createCover("fuel-1", "Fuel Cell", { x: 4.8, z: -1.6 }, { coverKind: "fuel", volatile: true }),
    createCover("fuel-2", "Fuel Cell", { x: 7.2, z: -2.3 }, { coverKind: "fuel", volatile: true }),
    createCover("ammo-1", "Ammo Cache", { x: 5.4, z: 1.3 }, { coverKind: "ammo", volatile: true }),
    createCover("ammo-2", "Ammo Cache", { x: 9.5, z: -7.7 }, { coverKind: "ammo", volatile: true }),
    createCover("conduit-1", "Power Conduit", { x: -4.3, z: 5.2 }, { coverKind: "conduit", volatile: true }),
    createCover("conduit-2", "Power Conduit", { x: 3.8, z: 7.4 }, { coverKind: "conduit", volatile: true }),
    createCover("ridge-1", "Mesa Rock", { x: 0.9, z: 5.2 }, { coverKind: "ridge", hp: 110, radius: 1.45, height: 1.9 }),
    createCover("ridge-2", "Mesa Rock", { x: 3.2, z: 5.8 }, { coverKind: "ridge", hp: 96, radius: 1.25, height: 1.55 }),
    createCover("ridge-3", "Mesa Rock", { x: -1.4, z: 5.9 }, { coverKind: "ridge", hp: 96, radius: 1.25, height: 1.55 }),
    createCover("cliff-1", "Cliff Ascent", { x: -1.2, z: 4.45 }, { coverKind: "cliff", hp: 180, radius: 1.05, height: 1.85 }),
    createCover("cliff-2", "Cliff Ascent", { x: 2.6, z: 4.45 }, { coverKind: "cliff", hp: 180, radius: 1.05, height: 1.85 }),
  ];
}
