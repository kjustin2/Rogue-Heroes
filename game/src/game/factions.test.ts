import { describe, expect, it } from "vitest";
import { DEFAULT_FACTION, FACTIONS, factionDef } from "./factions";
import { DEFENSE_CATALOG, SUPPORT_POWERS, TROOP_CATALOG, troopSpec } from "./units";
import { TECH_TREE } from "./tech";
import { TacticalSim, mapDef } from "./sim";

// A faction is a filter over the shared catalogs. These assert the filter is COHERENT -- the
// failure mode is not a crash, it is a card in the deck that can never be bought.
const TROOP_KINDS = new Set(TROOP_CATALOG.map((s) => s.kind));
const TECH_IDS = new Set(TECH_TREE.map((n) => n.id));
const DEFENSE_KINDS = new Set(DEFENSE_CATALOG.map((s) => s.kind));
const SUPPORT_KINDS = new Set(SUPPORT_POWERS.map((s) => s.kind));

describe("faction definitions", () => {
  it("has a unique id per faction and a resolvable default", () => {
    const ids = FACTIONS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(factionDef(DEFAULT_FACTION).id).toBe(DEFAULT_FACTION);
  });

  for (const faction of FACTIONS) {
    describe(faction.id, () => {
      it("references only real catalog entries", () => {
        for (const kind of faction.roster) expect(TROOP_KINDS.has(kind), `roster: ${kind}`).toBe(true);
        for (const id of faction.tech) expect(TECH_IDS.has(id), `tech: ${id}`).toBe(true);
        for (const kind of faction.defenses) expect(DEFENSE_KINDS.has(kind), `defense: ${kind}`).toBe(true);
        for (const kind of faction.supports) expect(SUPPORT_KINDS.has(kind), `support: ${kind}`).toBe(true);
      });

      it("can actually unlock everything on its roster", () => {
        // THE invariant that matters. A troop gated behind a tech node the faction cannot research
        // is a card that renders, costs money, and rejects forever.
        for (const kind of faction.roster) {
          const gate = troopSpec(kind).tech;
          if (gate) expect(faction.tech.includes(gate), `${kind} needs tech "${gate}"`).toBe(true);
        }
      });

      it("can research every tech it lists", () => {
        // Same trap one level up: a tech node whose prerequisite is outside the faction's tree.
        for (const id of faction.tech) {
          const node = TECH_TREE.find((n) => n.id === id);
          for (const req of node?.requires ?? []) {
            expect(faction.tech.includes(req), `tech "${id}" needs "${req}"`).toBe(true);
          }
        }
      });

      it("can build and deploy something", () => {
        expect(faction.roster.length).toBeGreaterThan(0);
        // At least one troop must need no tech at all, or the opening turn has nothing to buy.
        expect(faction.roster.some((kind) => !troopSpec(kind).tech), "no tech-free opener").toBe(true);
      });

      it("gives the AI a wishlist it can actually build", () => {
        for (const kind of faction.aiPreference) {
          expect(faction.roster.includes(kind), `aiPreference "${kind}" is off-roster`).toBe(true);
        }
      });
    });
  }
});

// The roster is only real if something enforces it. spawnFailureReason is the single deploy gate
// for BOTH the player (queueSpawnTroop) and the enemy commander (spawnTroopFor), so one clause
// there covers both -- and one missing clause uncovers both.
describe("faction gating is enforced, not just declared", () => {
  const armed = (): TacticalSim => {
    const sim = new TacticalSim();
    sim.configure(mapDef("ironworks"), "destroy", "normal", { player: "vanguard", enemy: "vanguard" });
    sim.economy.set("player", 9000);
    return sim;
  };

  it("rejects a troop that is off the faction roster", () => {
    const sim = armed();
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    const roster = sim.factionOf("player").roster;
    const offRoster = TROOP_CATALOG.map((s) => s.kind).find((k) => !roster.includes(k));
    if (!offRoster) return; // every faction currently carries the full catalog; nothing to reject yet
    expect(sim.spawnFailureReason(base, offRoster)).toMatch(/roster/i);
  });

  it("rejects research outside the faction doctrine", () => {
    const sim = armed();
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    const tech = sim.factionOf("player").tech;
    const offTree = TECH_TREE.map((n) => n.id).find((id) => !tech.includes(id));
    if (!offTree) return;
    expect(sim.researchFailureReason(base, offTree)).toMatch(/doctrine/i);
  });

  it("allows everything that IS on the roster", () => {
    // The over-gating direction: a gate that rejects its own roster is worse than no gate.
    const sim = armed();
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    for (const kind of sim.factionOf("player").roster) {
      const reason = sim.spawnFailureReason(base, kind);
      expect(reason ?? "", `${kind}: ${reason}`).not.toMatch(/roster/i);
    }
  });
});
