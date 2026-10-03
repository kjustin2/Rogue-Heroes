import { describe, expect, it } from "vitest";
import { aggregateTechEffect, TECH_TREE, techNode, troopsUnlockedBy } from "./tech";
import { DEFENSE_CATALOG, SUPPORT_POWERS } from "./units";

describe("techNode", () => {
  it("looks up nodes and returns undefined for unknown ids", () => {
    expect(techNode("assault")?.name).toBe("Assault Doctrine");
    expect(techNode("nope")).toBeUndefined();
  });
});

describe("TECH_TREE structure", () => {
  const ids = new Set(TECH_TREE.map((n) => n.id));

  it("every prerequisite refers to a real node", () => {
    for (const node of TECH_TREE) {
      for (const req of node.requires) expect(ids.has(req), `${node.id} requires missing ${req}`).toBe(true);
    }
  });

  it("exclusions are symmetric (both sides lock each other out)", () => {
    for (const node of TECH_TREE) {
      for (const ex of node.excludes ?? []) {
        expect(ids.has(ex), `${node.id} excludes missing ${ex}`).toBe(true);
        expect(techNode(ex)?.excludes ?? [], `${ex} should exclude ${node.id} back`).toContain(node.id);
      }
    }
  });

  it("an upgrade (a node with an effect) unlocks no troops; every other node opens troops, a defense or a strike", () => {
    for (const node of TECH_TREE) {
      if (node.effect) {
        expect(troopsUnlockedBy(node.id), `${node.id} should unlock no troops`).toHaveLength(0);
      } else {
        const opens = troopsUnlockedBy(node.id).length + DEFENSE_CATALOG.filter((d) => d.tech === node.id).length + SUPPORT_POWERS.filter((p) => p.tech === node.id).length;
        expect(opens, `${node.id} opens nothing`).toBeGreaterThan(0);
      }
    }
  });
});

describe("aggregateTechEffect", () => {
  it("returns neutral defaults with no specializations", () => {
    expect(aggregateTechEffect([])).toEqual({
      infantryDamage: 1, vsVehicleDamage: 1, infantryHp: 1, vehicleHp: 1,
      healBonus: 0, repairBonus: 0, splashDamage: 1, splashRadius: 1, evasion: 1, spotterBoost: 0,
    });
  });

  it("applies a single specialization's payoff", () => {
    expect(aggregateTechEffect(["breach"]).infantryDamage).toBeCloseTo(1.25);
    expect(aggregateTechEffect(["hunter"]).vsVehicleDamage).toBeCloseTo(1.3);
    expect(aggregateTechEffect(["cluster"]).splashRadius).toBeCloseTo(1.5);
    expect(aggregateTechEffect(["optics"]).spotterBoost).toBe(1);
  });

  it("sums flat bonuses and multiplies scalar bonuses across nodes", () => {
    const both = aggregateTechEffect(["triage", "welding"]);
    expect(both.healBonus).toBe(8);
    expect(both.repairBonus).toBe(10);
    // Multiplicative stacking (contrived, but proves the aggregation math).
    expect(aggregateTechEffect(["breach", "breach"]).infantryDamage).toBeCloseTo(1.25 * 1.25);
  });

  it("ignores unknown or effect-less ids", () => {
    expect(aggregateTechEffect(["assault", "bogus"])).toEqual(aggregateTechEffect([]));
  });
});

describe("tech tree design", () => {
  const pathCost = (id: string): number => {
    const node = techNode(id)!;
    return node.cost + node.requires.reduce((sum, req) => sum + pathCost(req), 0);
  };
  const opens = (id: string): number => troopsUnlockedBy(id).length + DEFENSE_CATALOG.filter((d) => d.tech === id).length + SUPPORT_POWERS.filter((p) => p.tech === id).length;

  it("every node opens something or carries an effect, so no branch is a dead end", () => {
    for (const node of TECH_TREE) expect(opens(node.id) + (node.effect ? 1 : 0) + TECH_TREE.filter((n) => n.requires.includes(node.id)).length, node.id).toBeGreaterThan(0);
  });

  it("recon answers air and shock troops answer armour, so neither threat needs the armour road", () => {
    expect(troopsUnlockedBy("recon")).toContain("flak");
    expect(troopsUnlockedBy("shock")).toContain("bazooka");
  });

  it("the tree is deep: four branches, five layers, and a real choice (an exclusive pair) on most of them", () => {
    const depth = (id: string): number => 1 + Math.max(0, ...techNode(id)!.requires.map(depth));
    expect(Math.max(...TECH_TREE.map((n) => depth(n.id)))).toBeGreaterThanOrEqual(4);
    expect(TECH_TREE.length).toBeGreaterThanOrEqual(24);
    expect(TECH_TREE.filter((n) => (n.excludes ?? []).length > 0).length).toBeGreaterThanOrEqual(10);
    // The pairs that unlock units, not just numbers: Fire Discipline vs Demolitions, Field Works vs Field Hospital.
    expect(techNode("incendiary")!.excludes).toContain("demolition");
    expect(techNode("fieldworks")!.excludes).toContain("fieldhospital");
  });

  it("aircraft and artillery are the deep end: they cost more to reach than any doctrine on its own", () => {
    for (const id of ["airwing", "siege"]) {
      for (const other of TECH_TREE.filter((n) => !n.effect && n.id !== id && n.id !== "airwing" && n.id !== "siege")) expect(pathCost(id), id).toBeGreaterThan(pathCost(other.id));
    }
    expect(techNode("airwing")!.requires).toContain("recon");
    expect(techNode("armor")!.requires).toContain("motorpool"); // tanks sit behind the light vehicles
  });

  it("an upgrade costs no more than a trooper and a half (it also spends the base order)", () => {
    for (const spec of TECH_TREE.filter((n) => n.effect)) expect(spec.cost, spec.id).toBeLessThanOrEqual(160);
  });
});
