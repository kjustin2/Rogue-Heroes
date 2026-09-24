import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef, troopSpec, unitStats } from "./sim";
import { FACTIONS, factionDef, signatureUnits, type FactionId } from "./factions";
import { SUPPORT_POWERS, type EntityKind } from "./units";

// FACTION IDENTITY (2026-09-23): each faction owns a block of units, one strike and one doctrine
// rule. These pin the three rules end to end and the roster shape that makes the factions differ.

const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (player: FactionId, enemy: FactionId = "vanguard"): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal", { player, enemy });
  return sim;
};
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const baseOf = (sim: TacticalSim, team: "player" | "enemy") => sim.entities.find((e) => e.kind === "base" && e.team === team)!;

// Same predicates as factionAi.test.ts: what the AI counts as an answer to armour / air.
const answersArmor = (kind: EntityKind): boolean => {
  const s = unitStats(kind);
  return s.groundShell || (s.burst >= 4 && s.weaponRange >= 14) || s.shotDamage >= 60;
};
const answersAir = (kind: EntityKind): boolean => ["flak", "heavy", "sniper", "interceptor"].includes(kind);

describe("faction rosters differ", () => {
  it("each faction owns at least four units nobody else fields", () => {
    for (const f of FACTIONS) expect(signatureUnits(f.id).length, f.id).toBeGreaterThanOrEqual(4);
  });

  it("shares no more than half its roster with any other faction", () => {
    for (const a of FACTIONS) for (const b of FACTIONS) {
      if (a.id === b.id) continue;
      const shared = a.roster.filter((k) => b.roster.includes(k)).length;
      expect(shared / a.roster.length, `${a.id} vs ${b.id}`).toBeLessThanOrEqual(0.6);
    }
  });

  it("keeps an answer to armour and to air in every roster", () => {
    for (const f of FACTIONS) {
      expect(f.roster.some(answersArmor), `${f.id} anti-armour`).toBe(true);
      expect(f.roster.some(answersAir), `${f.id} anti-air`).toBe(true);
    }
  });

  it("gives every faction two support powers of its own, all unlocked by its own research", () => {
    const all = FACTIONS.flatMap((f) => f.supports);
    for (const f of FACTIONS) expect(f.supports.length).toBe(2);
    expect(new Set(all).size).toBe(all.length); // nothing shared
    for (const f of FACTIONS) for (const kind of f.supports) {
      const spec = SUPPORT_POWERS.find((p) => p.kind === kind);
      expect(spec, kind).toBeDefined();
      // Nothing is callable on turn 1 (owner 2026-09-24): every power needs a doctrine this faction can research.
      expect(spec!.tech, `${kind} has no tech gate`).toBeDefined();
      expect(f.tech.includes(spec!.tech!), `${f.id} cannot research ${spec!.tech} for ${kind}`).toBe(true);
    }
  });

  it("names only units it fields, and the sim uses those names", () => {
    for (const f of FACTIONS) for (const kind of Object.keys(f.labels ?? {})) {
      expect(f.roster.includes(kind as never), `${f.id} labels off-roster ${kind}`).toBe(true);
    }
    const sim = staged("syndicate");
    expect(sim.troopLabel("player", "soldier")).toBe("Raider");
    expect(sim.troopLabel("enemy", "soldier")).toBe("Trooper");
    expect(sim.troopLabel("player", "flamer")).toBe(troopSpec("flamer").label);
  });
});

describe("Vanguard — Rapid Response", () => {
  it("cuts every troop and strike cooldown by a turn and widens the deploy ring", () => {
    const van = staged("vanguard", "bastion");
    expect(van.troopCooldownFor("player", "tank")).toBe(troopSpec("tank").cooldown - 1);
    expect(van.troopCooldownFor("enemy", "tank")).toBe(troopSpec("tank").cooldown);
    // Never below one turn: the rifleman stays on a one-turn cooldown.
    expect(van.troopCooldownFor("player", "soldier")).toBe(1);
    expect(van.supportCooldownFor("player", "airstrike")).toBe(2);
    expect(van.deployPlacementRadius(baseOf(van, "player")) - van.deployPlacementRadius(baseOf(van, "enemy"))).toBe(factionDef("vanguard").doctrine.deployReach);
  });

  it("applies the shorter cooldown when it actually deploys", () => {
    const sim = staged("vanguard");
    const base = baseOf(sim, "player");
    base.unlockedTech = ["assault", "armor"];
    sim.economy.set("player", 5000);
    sim.select(base.id);
    expect(sim.queueSpawnTroop("tank")).toBe(true);
    expect(sim.troopCooldown(base, "tank")).toBe(2);
  });
});

describe("Syndicate — Scavengers", () => {
  it("pays 30% of a destroyed enemy unit's cost to the killer's side", () => {
    const sim = staged("syndicate");
    const raider = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const victim = sim.debugSpawn("tank", "enemy", { x: 4, z: 0 });
    sim.economy.set("player", 100);
    for (const p of victim.parts) if (p.critical) sim.debugDamage(victim.id, p.id, 9999, raider.id);
    expect(victim.status.alive).toBe(false);
    expect(sim.money("player")).toBe(100 + Math.round(troopSpec("tank").cost * 0.3));
    expect(sim.log.some((l) => l.startsWith("Scavenged"))).toBe(true);
  });

  it("pays nothing to a faction without the doctrine", () => {
    const sim = staged("vanguard", "syndicate");
    const shooter = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const victim = sim.debugSpawn("soldier", "enemy", { x: 4, z: 0 });
    sim.economy.set("player", 100);
    for (const p of victim.parts) if (p.critical) sim.debugDamage(victim.id, p.id, 9999, shooter.id);
    expect(victim.status.alive).toBe(false);
    expect(sim.money("player")).toBe(100);
  });
});

describe("Bastion — Dig In", () => {
  it("a unit that holds a full turn digs in and takes 20% less; moving climbs it out", () => {
    const sim = staged("bastion");
    const guard = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    // First turn held: digging, not yet protected.
    sim.endTurn();
    expect(guard.digging).toBe(true);
    expect(guard.dugIn).toBeUndefined();
    settle(sim);
    // Second turn held: dug in.
    sim.endTurn();
    settle(sim);
    expect(guard.dugIn).toBe(0.8);
    expect(sim.log.some((l) => l.includes("digs in"))).toBe(true);
    const core = guard.parts.find((p) => p.critical)!;
    const before = core.hp;
    sim.debugDamage(guard.id, core.id, 20);
    expect(before - core.hp).toBe(16);
    // It rides a save.
    const restored = new TacticalSim();
    restored.restore(sim.serialize());
    expect(restored.entities.find((e) => e.id === guard.id)?.dugIn).toBe(0.8);
    // Next turn it moves: no longer dug in.
    sim.debugSelect(guard.id);
    expect(sim.queueMove({ x: -3, z: 0 })).toBe(true);
    sim.endTurn();
    expect(guard.dugIn).toBeUndefined();
    expect(guard.digging).toBeUndefined();
  });

  it("other factions never dig in, and a Bastion tank keeps hull-down instead", () => {
    const sim = staged("vanguard", "bastion");
    const trooper = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    const tank = sim.debugSpawn("tank", "enemy", { x: 6, z: 6 });
    disarm(tank);
    for (let turn = 0; turn < 2; turn += 1) { sim.endTurn(); settle(sim); }
    expect(trooper.dugIn).toBeUndefined();
    expect(tank.dugIn).toBeUndefined();
  });
});

describe("the bot calls its faction's strike", () => {
  const scene = (friendlyNear: boolean): TacticalSim => {
    const sim = staged("vanguard", "syndicate");
    const base = baseOf(sim, "enemy");
    base.unlockedTech = ["assault", "ordnance"];
    sim.economy.set("enemy", 3000);
    for (const [i, x] of [0, 1.4, 2.8].entries()) disarm(sim.debugSpawn("soldier", "player", { x, z: i * 0.5 }));
    sim.debugSpawn("soldier", "enemy", { x: 14, z: 10 });
    sim.debugSpawn("soldier", "enemy", friendlyNear ? { x: 4, z: 1 } : { x: 14, z: -10 });
    return sim;
  };

  it("drops a Cluster Strike on a clump of hostiles", () => {
    const sim = scene(false);
    sim.endTurn();
    expect(sim.supportCooldown(baseOf(sim, "enemy"), "cluster")).toBeGreaterThan(0);
  });

  it("holds it when its own troops stand in the blast", () => {
    const sim = scene(true);
    sim.endTurn();
    expect(sim.supportCooldown(baseOf(sim, "enemy"), "cluster")).toBe(0);
  });
});
