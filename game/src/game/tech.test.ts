import { describe, expect, it } from "vitest";
import { aggregateTechEffect, TECH_TREE, techNode, troopsUnlockedBy } from "./tech";

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
    expect(aggregateTechEffect(["breach"]).infantryDamage).toBeCloseTo(1.18);
    expect(aggregateTechEffect(["hunter"]).vsVehicleDamage).toBeCloseTo(1.2);
    expect(aggregateTechEffect(["cluster"]).splashRadius).toBeCloseTo(1.45);
    expect(aggregateTechEffect(["optics"]).spotterBoost).toBe(1);
  });

  it("sums flat bonuses and multiplies scalar bonuses across nodes", () => {
    const both = aggregateTechEffect(["triage", "welding"]);
    expect(both.healBonus).toBe(6);
    expect(both.repairBonus).toBe(8);
    // Multiplicative stacking (contrived, but proves the aggregation math).
    expect(aggregateTechEffect(["breach", "breach"]).infantryDamage).toBeCloseTo(1.18 * 1.18);
  });

  it("ignores unknown or effect-less ids", () => {
    expect(aggregateTechEffect(["assault", "bogus"])).toEqual(aggregateTechEffect([]));
  });
});
