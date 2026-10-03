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

  it("doctrines unlock troops; specializations carry an effect and unlock none", () => {
    for (const node of TECH_TREE) {
      if (node.effect) {
        // A tier-4 specialization: a combat modifier, not a troop unlock.
        expect(troopsUnlockedBy(node.id), `${node.id} should unlock no troops`).toHaveLength(0);
      } else {
        // A doctrine: must field at least one troop, or it's dead weight.
        expect(troopsUnlockedBy(node.id).length, `${node.id} unlocks nothing`).toBeGreaterThan(0);
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

  it("every doctrine opens something, so no branch is a dead end", () => {
    for (const node of TECH_TREE.filter((n) => n.tier < 4)) {
      const opens = troopsUnlockedBy(node.id).length
        + DEFENSE_CATALOG.filter((d) => d.tech === node.id).length
        + SUPPORT_POWERS.filter((p) => p.tech === node.id).length
        + TECH_TREE.filter((n) => n.requires.includes(node.id)).length;
      expect(opens, node.id).toBeGreaterThan(0);
    }
  });

  it("recon answers air and assault answers armour, so neither threat needs the armour road", () => {
    expect(troopsUnlockedBy("recon")).toContain("flak");
    expect(troopsUnlockedBy("assault")).toContain("bazooka");
  });

  it("aircraft and artillery are the deep end: they cost more to reach than anything else", () => {
    for (const id of ["airwing", "siege"]) {
      for (const other of TECH_TREE.filter((n) => n.tier < 3)) expect(pathCost(id), id).toBeGreaterThan(pathCost(other.id));
    }
    expect(techNode("airwing")!.requires).toContain("recon");
  });

  it("an upgrade costs no more than a trooper and a half (it also spends the base order)", () => {
    for (const spec of TECH_TREE.filter((n) => n.tier === 4)) {
      expect(spec.cost, spec.id).toBeLessThanOrEqual(160);
    }
  });
});
