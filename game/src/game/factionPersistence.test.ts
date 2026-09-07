import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// PERSISTENCE TRIPWIRE for the faction pick.
//
// persistence.test.ts round-trips restore(serialize()) and compares the result against itself. That
// cannot catch a field missing from serialize: a field that is never written is never written on
// EITHER side, so the comparison passes. It also cannot catch it when both sides sit on the default
// value. So this test does two things that one deliberately does not: it uses a NON-DEFAULT pair,
// and it asserts on the raw JSON rather than on a round-trip.
describe("faction survives a save", () => {
  const configured = (): TacticalSim => {
    const sim = new TacticalSim();
    sim.configure(mapDef("ironworks"), "destroy", "normal", { player: "bastion", enemy: "syndicate" });
    return sim;
  };

  it("is actually written into the save payload", () => {
    const raw = JSON.parse(configured().serialize()) as { factions?: Record<string, string> };
    expect(raw.factions?.player).toBe("bastion");
    expect(raw.factions?.enemy).toBe("syndicate");
  });

  it("comes back on the other side", () => {
    const saved = configured().serialize();
    const fresh = new TacticalSim();
    expect(fresh.restore(saved)).toBe(true);
    expect(fresh.factionOf("player").id).toBe("bastion");
    expect(fresh.factionOf("enemy").id).toBe("syndicate");
  });

  it("loads a save written before factions existed", () => {
    // Old saves have no `factions` key at all; they must open on the default, not throw.
    const legacy = JSON.parse(configured().serialize()) as Record<string, unknown>;
    delete legacy.factions;
    const sim = new TacticalSim();
    expect(sim.restore(JSON.stringify(legacy))).toBe(true);
    expect(sim.factionOf("player").id).toBe("vanguard");
  });

  it("is not clobbered by reset()", () => {
    // reset() re-runs configure() with no faction argument. If that argument were not optional,
    // restarting a battle would silently switch the player back to the default faction.
    const sim = configured();
    sim.reset();
    expect(sim.factionOf("player").id).toBe("bastion");
    expect(sim.factionOf("enemy").id).toBe("syndicate");
  });
});
