import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef, unitStats } from "./sim";
import { TROOP_CATALOG, type EntityKind } from "./units";

// The enemy AI's build logic became faction-aware. Two things must hold, and neither shows up as a
// crash if it breaks -- both look like "the AI is being passive".
const sim = new TacticalSim();
const kinds = TROOP_CATALOG.map((s) => s.kind);

// Mirrors of the sim's private role predicates, exercised through the exported stat table. These
// pin the ROLE-BASED rewrite to the hardcoded kind lists it replaced.
const answersArmor = (kind: EntityKind): boolean => {
  const s = unitStats(kind);
  // The reach gate is load-bearing: adding a 7-pellet scattergun to the roster made a bare
  // `burst >= 4` declare a knife-range shotgun an answer to armour, which would have made the AI
  // believe it was already covered and stop building real ones. Sustained fire counts only with
  // the range to use it.
  return s.groundShell || (s.burst >= 4 && s.weaponRange >= 14) || s.shotDamage >= 60;
};
const answersAir = (kind: EntityKind): boolean => {
  const s = unitStats(kind);
  if (kind === "gunship" || kind === "interceptor" || kind === "bomber" || kind === "transport") return false;
  if (kind === "flak") return true; // carries the vsAir multiplier
  return !s.groundShell && (s.shotDamage >= 40 || (s.burst >= 4 && s.weaponRange >= 14));
};

describe("faction-aware AI build logic", () => {
  it("still classifies exactly the old anti-armour set", () => {
    // Was: tank | artillery | heavy | grenadier | mortar. A role predicate that quietly widened
    // this would make the AI think it already counters your tanks and stop building answers.
    const got = kinds.filter(answersArmor).sort();
    expect(got).toEqual(["artillery", "grenadier", "heavy", "mortar", "tank"]);
  });

  it("still classifies exactly the old anti-air set", () => {
    // Was: flak | heavy | sniper. vsAir only exists on three units, so a naive "has vsAir" rewrite
    // silently drops heavy and sniper and the AI over-builds flak.
    const got = kinds.filter(answersAir).sort();
    expect(got).toEqual(["flak", "heavy", "sniper"]);
  });

  it("fields only on-roster units, and still fields something", () => {
    // spawnFailureReason's roster clause is what actually keeps off-roster units off the board --
    // it gates the AI's deploys exactly as it gates the player's. The second assertion is the one
    // that would catch over-gating: a faction filter tight enough to leave the enemy unable to
    // build anything reads in play as "the AI is doing nothing", not as an error.
    sim.configure(mapDef("ironworks"), "destroy", "normal", { player: "vanguard", enemy: "bastion" });
    const roster = sim.factionOf("enemy").roster;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
    expect(base).toBeDefined();
    sim.economy.set("enemy", 9000);
    // Drive several turns and assert every enemy unit that reaches the field is on-roster.
    for (let turn = 0; turn < 4; turn += 1) {
      sim.endTurn();
      for (let t = 0; t < 30 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    }
    const fielded = sim.entities.filter((e) => e.team === "enemy" && e.kind !== "base" && e.kind !== "cover");
    expect(fielded.length, "enemy never deployed anything").toBeGreaterThan(0);
    for (const unit of fielded) {
      expect(roster.includes(unit.kind as never), `${unit.kind} is off-roster`).toBe(true);
    }
  });
});
