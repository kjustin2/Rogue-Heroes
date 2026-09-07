import { describe, expect, it } from "vitest";
import { TROOP_CATALOG, UNIT_STATS, troopSpec, unitStats, type EntityKind, type TroopKind } from "./units";
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

// STRUCTURAL GATE on UNIT_STATS. The equivalence test that proved the table reproduced the old
// ladders did its job at the moment of the flip and is gone; what remains worth asserting is that
// every kind is described and that the description is internally coherent.
describe("UNIT_STATS describes every kind coherently", () => {
  const STRUCTURES: readonly EntityKind[] = ["base", "turret", "exturret", "wall", "cover"];
  const ALL: readonly EntityKind[] = [...ALL_KINDS, ...STRUCTURES];

  it("has an entry for every entity kind and no strays", () => {
    expect(Object.keys(UNIT_STATS).sort()).toEqual([...ALL].sort());
  });

  it("gives every deployable troop the ability to move", () => {
    // A troop with no move range is a troop you pay for and cannot reposition.
    for (const kind of ALL_KINDS) {
      const s = unitStats(kind);
      expect(s.moveRange, `${kind} moveRange`).toBeGreaterThan(0);
      expect(s.moveSpeed, `${kind} moveSpeed`).toBeGreaterThan(0);
    }
  });

  it("keeps emplacements and scenery immobile", () => {
    for (const kind of STRUCTURES) {
      expect(unitStats(kind).moveRange, `${kind} moveRange`).toBe(0);
      expect(unitStats(kind).moveSpeed, `${kind} moveSpeed`).toBe(0);
    }
  });

  it("gives every kind a band at which it is still accurate", () => {
    // spreadStart is the distance that costs no extra spread. It must be positive, or a unit is
    // penalized at literally every range it can shoot. A spreadStart at or beyond a unit's own
    // weapon range is fine and deliberate -- that unit is simply accurate everywhere it can reach,
    // which is how the flamer (range 7.5, start 9) is meant to work.
    for (const kind of ALL) {
      expect(unitStats(kind).spreadStart, `${kind} spreadStart`).toBeGreaterThan(0);
    }
  });
});
