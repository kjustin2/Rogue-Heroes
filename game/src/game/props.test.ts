import { describe, expect, it } from "vitest";
import { createCover, createSoldier, isLandmarkKind, type CoverKind } from "./damageModel";
import { MAPS, mapDef } from "./maps";
import { TacticalSim } from "./sim";

// EVERY MAP'S FURNITURE BELONGS TO ITS BIOME, AND THERE IS PLENTY OF IT (2026-09-23).
//
// Two ways this went wrong before anyone counted: (1) a kind borrowed from another map because it
// was in the list (a Roman column standing in the Ironworks foundry), and (2) scatter drawing a new
// kind on every placement ATTEMPT, which is rejection sampling that favours the smallest prop — the
// foundry floor listed pipes, silos, fuel and crates and came out as twelve gas bottles, and half
// of every palette never appeared on its own map. The first test pins (1), the next two pin (2).

// Kinds that say WHICH map this is. Each may appear on its home map(s) only.
const HOME: Partial<Record<CoverKind, readonly string[]>> = {
  cactus: ["dustbowl"], bones: ["dustbowl"], tent: ["dustbowl"],
  girder: ["ironworks"], coil: ["ironworks"], ingot: ["ironworks"], gas: ["ironworks"], railcar: ["ironworks"],
  haybale: ["verdant"], fence: ["verdant"], grave: ["verdant"],
  hut: ["causeway"], boat: ["causeway"], rack: ["causeway"], iceblock: ["causeway"],
  pillar: ["karak"], statue: ["karak"], obelisk: ["karak"], urn: ["karak"], brazier: ["karak"],
  hedgehog: ["crossfire"], tower: ["crossfire"],
  // Foliage grows where things grow: never on the ice, the slag or the desert floor.
  tree: ["verdant", "crossfire"], bush: ["verdant", "crossfire", "karak"],
};

function propsOn(mapId: string): Array<{ kind: CoverKind }> {
  const sim = new TacticalSim();
  sim.configure(mapDef(mapId), "destroy", "normal");
  return sim.entities
    .filter((e) => e.kind === "cover" && e.coverKind && e.coverKind !== "span")
    .map((e) => ({ kind: e.coverKind as CoverKind }));
}
describe("map props fit the biome", () => {
  for (const map of MAPS) {
    const props = propsOn(map.id);
    const kinds = new Set(props.map((p) => p.kind));

    it(`${map.id}: no prop from another biome`, () => {
      const strays = [...kinds].filter((k) => HOME[k] && !HOME[k]!.includes(map.id));
      expect(strays, `${map.id} carries ${strays.join(", ")}`).toEqual([]);
    });

    it(`${map.id}: every kind its palettes list actually appears`, () => {
      const listed = new Set([...map.scatter.flatMap((g) => g.palette), ...(map.signature ?? []).map((s) => s.kind)]);
      const missing = [...listed].filter((k) => !kinds.has(k));
      expect(missing, `${map.id} lists but never places ${missing.join(", ")}`).toEqual([]);
    });

    it(`${map.id}: at least ten kinds of furniture besides its landmarks`, () => {
      const furniture = [...kinds].filter((k) => !isLandmarkKind(k));
      expect(furniture.length, `${map.id}: ${furniture.join(", ")}`).toBeGreaterThanOrEqual(10);
    });
  }
});

describe("biome props behave like what they are", () => {
  for (const kind of ["girder", "obelisk", "tower"] as const) {
    it(`a felled ${kind} topples like a pillar and crushes what it lands on`, () => {
      const shooter = createSoldier("p-shooter", "Shooter", "player", { x: 0, z: 0 });
      const prop = createCover(`${kind}-1`, kind, { x: 3, z: 0 }, { coverKind: kind });
      const bystander = createSoldier("e-bystander", "Bystander", "enemy", { x: 5.2, z: 0 });
      const sim = new TacticalSim([shooter, prop, bystander]);
      const before = bystander.parts.reduce((sum, p) => sum + p.hp, 0);
      sim.debugDamage(prop.id, prop.parts[0].id, 9999, shooter.id);
      expect(sim.toppled.has(prop.id)).toBe(true);
      expect(bystander.parts.reduce((sum, p) => sum + p.hp, 0)).toBeLessThan(before);
    });
  }

  it("a broken oil brazier bursts and leaves the ground burning, like a fuel drum", () => {
    const shooter = createSoldier("p-shooter", "Shooter", "player", { x: 0, z: 0 });
    const brazier = createCover("brazier-1", "Oil Brazier", { x: 4, z: 0 }, { coverKind: "brazier" });
    const sim = new TacticalSim([shooter, brazier]);
    expect(brazier.parts[0].role).toBe("volatile");
    sim.debugDamage(brazier.id, brazier.parts[0].id, 9999, shooter.id);
    expect(sim.burnZones.length).toBe(1);
  });
});
