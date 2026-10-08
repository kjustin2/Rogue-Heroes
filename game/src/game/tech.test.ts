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
  it("returns neutral defaults with nothing researched (the stat-bump upgrades were cut, 2026-10-07)", () => {
    expect(aggregateTechEffect([])).toEqual({
      infantryDamage: 1, vsVehicleDamage: 1, infantryHp: 1, vehicleHp: 1,
      splashDamage: 1, splashRadius: 1, evasion: 1,
    });
    expect(aggregateTechEffect(["recon", "assault", "nope"])).toEqual(aggregateTechEffect([]));
  });

  it("folds in a faction's built-in passive", () => {
    expect(aggregateTechEffect([], { infantryHp: 1.1 }).infantryHp).toBeCloseTo(1.1);
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

  it("the tree is focused: every node opens something you can see, four layers deep, one real either/or", () => {
    const depth = (id: string): number => 1 + Math.max(0, ...techNode(id)!.requires.map(depth));
    expect(Math.max(...TECH_TREE.map((n) => depth(n.id)))).toBeGreaterThanOrEqual(4);
    expect(TECH_TREE.filter((n) => n.effect)).toEqual([]); // no invisible stat bumps (owner 2026-10-07)
    // The pairs that unlock units, not just numbers: Fire Discipline vs Demolitions.
    expect(techNode("incendiary")!.excludes).toContain("demolition");
  });

  it("aircraft and artillery are the deep end: they cost more to reach than any doctrine on its own", () => {
    for (const id of ["airwing", "siege"]) {
      for (const other of TECH_TREE.filter((n) => !n.effect && n.id !== id && n.id !== "airwing" && n.id !== "siege")) expect(pathCost(id), id).toBeGreaterThan(pathCost(other.id));
    }
    expect(techNode("airwing")!.requires).toContain("recon");
    expect(techNode("armor")!.requires).toContain("motorpool"); // tanks sit behind the light vehicles
  });
});
