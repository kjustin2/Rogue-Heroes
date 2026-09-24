import { describe, expect, it } from "vitest";
import { COVER_PROFILES, createCover, createSoldier, isLandmarkKind, type CoverKind } from "./damageModel";
import { BASE_CLEAR, MAPS, WALK_GAP, mapDef, pinchesTerrain } from "./maps";
import { TacticalSim } from "./sim";

// EVERY MAP'S FURNITURE BELONGS TO ITS BIOME, AND THERE IS LITTLE OF IT (2026-09-23).
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

const MAX_PROPS = 20; // blocking props per map, both halves, excluding bridge spans and capturables

function propsOn(mapId: string): Array<{ kind: CoverKind }> {
  const sim = new TacticalSim();
  sim.configure(mapDef(mapId), "destroy", "normal");
  return sim.entities
    .filter((e) => e.kind === "cover" && e.coverKind && e.coverKind !== "span" && !e.capturable)
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

    // MINIMAL, NOT DENSE (owner 2026-09-23: "way too many items on the board so it blocks movement
    // all over... make each unique impactful and relevant to that map"). This replaced a test that
    // demanded ten kinds of furniture per map, which is how the boards filled up.
    it(`${map.id}: few props (at most ${MAX_PROPS}), one landmark, at least one that explodes`, () => {
      expect(props.length, `${map.id} places ${props.length} props`).toBeLessThanOrEqual(MAX_PROPS);
      expect([...kinds].some((k) => isLandmarkKind(k)), `${map.id} has no landmark`).toBe(true);
      expect([...kinds].some((k) => COVER_PROFILES[k].volatile), `${map.id} has nothing volatile`).toBe(true);
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

// WALKING ROOM (owner 2026-09-23: "if there's a base or an object on the map there's not any other
// base spot or object immediately near it... so that there's always generally space to walk by").
// Every pair of solid things -- bases, turrets, landmarks, props, depots -- keeps WALK_GAP of open
// ground edge to edge -- room for two tanks abreast ("ensure enough space for 2 tanks to get through
// any space") -- and no prop leaves a tank-width-short gap against a cliff step or water.
describe("walking room between everything on the map", () => {
  for (const map of MAPS) {
    it(`${map.id}: at least ${WALK_GAP}m of open ground between any two solid things`, () => {
      const sim = new TacticalSim();
      sim.configure(mapDef(map.id), "destroy", "normal");
      const solid = sim.entities.filter((e) => e.status.alive && (e.kind === "cover"
        ? e.coverKind !== "span" && e.coverKind !== "ridge" && e.coverKind !== "cliff"
        : e.kind === "base" || e.kind === "turret"));
      const cramped: string[] = [];
      for (let i = 0; i < solid.length; i += 1) {
        for (let j = i + 1; j < solid.length; j += 1) {
          const a = solid[i], b = solid[j];
          const gap = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) - a.radius - b.radius;
          if (gap < WALK_GAP - 0.01) cramped.push(`${a.coverKind ?? a.kind}~${b.coverKind ?? b.kind} ${gap.toFixed(2)}m`);
        }
      }
      expect(cramped, `${map.id}: ${cramped.join(", ")}`).toEqual([]);
      // The deploy ring is clear: nothing solid (props, capturables) inside BASE_CLEAR of a base.
      const bases = solid.filter((e) => e.kind === "base");
      const crowding = solid.filter((e) => e.kind !== "base" && bases.some((b) => Math.hypot(e.position.x - b.position.x, e.position.z - b.position.z) < BASE_CLEAR + e.radius - 0.01));
      expect(crowding.map((e) => e.coverKind ?? e.kind), `${map.id}: objects inside a base's deploy ring`).toEqual([]);
      const pinches = solid.filter((e) => e.kind === "cover" && pinchesTerrain(e.position, e.radius, map.terrain.bounds)).map((e) => e.coverKind);
      expect(pinches, `${map.id}: props pinching a lane against terrain`).toEqual([]);
    });
  }
});
