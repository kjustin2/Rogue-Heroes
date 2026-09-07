import { describe, expect, it } from "vitest";
import { TROOP_CATALOG, troopSpec, type TroopKind } from "./units";
import { isAirKind, isInfantryKind, isVehicleKind } from "./damageModel";
import { TacticalSim } from "./sim";

// EXHAUSTIVENESS TRIPWIRES.
//
// Entity kinds now live in one union (units.ts), so a missing TYPE is a compile error. These cover
// the failures the type system still cannot see: a kind that typechecks everywhere but falls
// through a dispatch at runtime. Each assertion below maps to a real silent-failure mode.
const ALL_KINDS: readonly TroopKind[] = TROOP_CATALOG.map((spec) => spec.kind);

describe("every troop kind is wired end to end", () => {
  it("has a catalog entry", () => {
    // troopSpec() falls back to TROOP_CATALOG[0] on a miss, so a kind absent from the catalog
    // silently costs and describes itself as a Recruit.
    for (const kind of ALL_KINDS) expect(troopSpec(kind).kind).toBe(kind);
  });

  it("spawns as itself", () => {
    // makeTroopBase ends in `default: return createSoldier(...)`. A kind with no case spawns a
    // soldier wearing the right label and cost -- it typechecks, tests pass, and the wrong unit is
    // on the field. This is the only thing that catches that.
    const sim = new TacticalSim([]);
    for (const kind of ALL_KINDS) {
      const unit = sim.debugSpawn(kind, "player", { x: 0, z: 0 });
      expect(unit.kind, `${kind} spawned as ${unit.kind}`).toBe(kind);
    }
  });

  it("classifies as exactly one of infantry or vehicle", () => {
    // worldRenderer's build dispatch is an if-chain with NO else and branches on these predicates.
    // A kind matching neither renders as a bare contact shadow -- invisible but still selectable.
    for (const kind of ALL_KINDS) {
      const infantry = isInfantryKind(kind);
      const vehicle = isVehicleKind(kind);
      expect(infantry !== vehicle, `${kind}: infantry=${infantry} vehicle=${vehicle}`).toBe(true);
    }
  });

  it("keeps flight a flag on the vehicle class, not a third class", () => {
    // isAirKind is deliberately a SUBSET of isVehicleKind -- aircraft ride the vehicle chassis
    // plumbing. If that ever inverts, air units lose their move/shoot wiring.
    for (const kind of ALL_KINDS) {
      if (isAirKind(kind)) expect(isVehicleKind(kind), `${kind} flies but is not a vehicle`).toBe(true);
    }
  });
});
