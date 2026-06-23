// Logic-test counterpart to the self-improvement loop's objective goals
// (improve/goals.mjs). These assert the in-game VALUES and STATE transitions the
// goals depend on, in-process and deterministically — the "logical" half of the
// two-signal verification (the "visual" half is the captured screenshots).
//
// Keep the `describe("loop goals")` title: improve/check-goals.mjs treats it as
// the required green suite for the loop to trust a cycle.

import { describe, expect, it } from "vitest";
import { applyDamage, createCover, createScout, createSoldier, createStriker, createTank } from "./damageModel";
import { COMMAND_UPGRADE_COST, TacticalSim, defenseSpec, mapDef, troopSpec } from "./sim";
import { SCENARIOS, SCENARIO_IDS, applyScenario } from "./scenarios";

function advanceUntil(sim: TacticalSim, predicate: () => boolean, seconds = 16): void {
  for (let t = 0; t < seconds && !predicate(); t += 0.05) sim.update(0.05);
}

function freshMatch(): TacticalSim {
  const sim = new TacticalSim();
  sim.configure(mapDef("ironworks"), "destroy", "normal");
  sim.economy.set("player", 3000);
  return sim;
}

function playerBase(sim: TacticalSim) {
  return sim.entities.find((e) => e.kind === "base" && e.team === "player")!;
}

describe("loop goals", () => {
  it("G3: starts in command phase, turn 1, with no units fielded", () => {
    const sim = freshMatch();
    expect(sim.phase).toBe("command");
    expect(sim.turn).toBe(1);
    expect(sim.fieldUnitCount("player")).toBe(0);
    expect(sim.fieldUnitCount("enemy")).toBe(0);
  });

  it("G5: deploying a Recruit adds a field unit and spends money + the base CP", () => {
    const sim = freshMatch();
    const base = playerBase(sim);
    sim.select(base.id);
    const money0 = sim.money("player");
    const field0 = sim.fieldUnitCount("player");
    expect(sim.queueSpawnTroop("soldier")).toBe(true);
    expect(sim.fieldUnitCount("player")).toBe(field0 + 1);
    expect(sim.money("player")).toBe(money0 - troopSpec("soldier").cost);
    expect(base.commandPoints).toBe(0);
  });

  it("G6: researching a doctrine unlocks it on the base", () => {
    const sim = freshMatch();
    const base = playerBase(sim);
    sim.select(base.id);
    expect(sim.researchTech("assault")).toBe(true);
    expect(base.unlockedTech ?? []).toContain("assault");
  });

  it("G7: a resolved rifle shot reduces an enemy part's health", () => {
    const enemy = createSoldier("e1", "Foe", "enemy", { x: 3, z: 0 });
    const sim = new TacticalSim([createSoldier("p1", "Me", "player", { x: 0, z: 0 }), enemy]);
    sim.select("p1");
    const hp0 = enemy.parts.reduce((a, p) => a + p.hp, 0);
    const part = enemy.parts.find((p) => p.hp > 0)!;
    expect(sim.queueShootPart("e1", part.id)).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.phase === "command");
    const hp1 = enemy.parts.reduce((a, p) => a + p.hp, 0);
    expect(hp1).toBeLessThan(hp0);
  });

  it("G8: landing the killing blow on the last enemy reaches a victory end-state", () => {
    // The real win check fires when a damage event lands during resolve, so we leave the
    // last enemy on a 1-HP core and have an adjacent shooter destroy it for real.
    const enemy = createSoldier("e1", "Foe", "enemy", { x: 2.4, z: 0 });
    const core = enemy.parts.find((p) => p.role === "core")!;
    for (const p of enemy.parts) p.hp = p.id === core.id ? 1 : 0;
    const sim = new TacticalSim([createSoldier("p1", "Me", "player", { x: 0, z: 0 }), enemy]);
    sim.select("p1");
    expect(sim.queueShootPart("e1", core.id)).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.gameOver, 12);
    expect(sim.phase).toBe("victory");
  });

  it("G9: Move intent exposes a positive movement-range radius", () => {
    const sim = new TacticalSim([
      createSoldier("p1", "Me", "player", { x: 0, z: 0 }),
      createSoldier("e1", "Foe", "enemy", { x: 8, z: 0 }),
    ]);
    sim.select("p1");
    sim.setIntent("move");
    const r = sim.selectedActionRange();
    expect(r?.kind).toBe("move");
    expect(r!.radius).toBeGreaterThan(0);
  });

  it("G10: grenade ground-aim previews a reachable blast radius", () => {
    const sim = new TacticalSim([
      createSoldier("p1", "Me", "player", { x: 0, z: 0 }),
      createSoldier("e1", "Foe", "enemy", { x: 6, z: 0 }),
    ]);
    sim.select("p1");
    sim.setIntent("grenade");
    const g = sim.groundAimPreview({ x: 3, z: 0 });
    expect(g).toBeTruthy();
    expect(g!.radius).toBeGreaterThan(0);
    expect(g!.reachable).toBe(true);
  });

  it("G11: build placement exposes a range ring near the base", () => {
    const sim = freshMatch();
    const base = playerBase(sim);
    sim.select(base.id);
    sim.setPendingBuild("turret");
    const b = sim.buildPlacement();
    expect(b).toBeTruthy();
    expect(b!.radius).toBeGreaterThan(0);
  });

  it("G13: a destroyed part stays listed on the entity at 0 HP", () => {
    const enemy = createTank("e1", "Foe", "enemy", { x: 5, z: 0 });
    const part = enemy.parts.find((p) => !p.critical) ?? enemy.parts[0];
    applyDamage(enemy, part.id, 9999);
    const still = enemy.parts.find((p) => p.id === part.id);
    expect(still).toBeTruthy();
    expect(still!.hp).toBe(0);
  });
});

const totalHp = (e: { parts: { maxHp: number }[] }): number => e.parts.reduce((a, p) => a + p.maxHp, 0);

function deployForTest(sim: TacticalSim, kind: Parameters<TacticalSim["queueSpawnTroop"]>[0]) {
  const base = playerBase(sim);
  base.unlockedTech = ["recon", "assault", "support", "ordnance", "armor", "siege"];
  base.maxCommandPoints = 6;
  base.commandPoints = 6;
  sim.economy.set("player", 9999);
  sim.select(base.id);
  expect(sim.queueSpawnTroop(kind)).toBe(true);
  return sim.entities.find((e) => e.team === "player" && e.kind === kind && e.id.startsWith("p-spawn-"))!;
}

describe("batch balance + UX fixes", () => {
  it("the +1 CP command upgrade is a heavier investment than before", () => {
    expect(COMMAND_UPGRADE_COST).toBeGreaterThan(320);
  });

  it("higher-tier units and emplacements cost more than line troops", () => {
    expect(troopSpec("artillery").cost).toBeGreaterThan(troopSpec("soldier").cost);
    expect(troopSpec("tank").cost).toBeGreaterThan(troopSpec("heavy").cost);
    expect(defenseSpec("exturret").cost).toBeGreaterThan(defenseSpec("turret").cost);
  });

  it("a tank fields with much more health than a recruit, matching its higher cost", () => {
    const soldier = deployForTest(freshMatch(), "soldier");
    const tank = deployForTest(freshMatch(), "tank");
    expect(totalHp(tank)).toBeGreaterThan(totalHp(soldier) * 1.5);
    expect(troopSpec("tank").cost).toBeGreaterThan(troopSpec("soldier").cost);
  });

  it("the second move ring originates from the projected post-move position", () => {
    const sim = new TacticalSim([
      createScout("p1", "Me", "player", { x: 0, z: 0 }),
      createSoldier("e1", "Foe", "enemy", { x: 14, z: 0 }),
    ]);
    sim.select("p1");
    sim.setIntent("move");
    expect(sim.queueMove({ x: 6, z: 0 })).toBe(true);
    const ring = sim.selectedActionRange();
    expect(ring?.kind).toBe("move");
    // Origin should have advanced toward the queued destination, not stayed at x=0.
    expect(ring!.position.x).toBeGreaterThan(3);
  });

  it("the Strike preview reports a concrete damage number", () => {
    const sim = new TacticalSim([
      createStriker("p1", "Me", "player", { x: 0, z: 0 }),
      createSoldier("e1", "Foe", "enemy", { x: 1.6, z: 0 }),
    ]);
    sim.select("p1");
    const dmg = sim.previewMeleeDamage("e1");
    expect(dmg).toBeGreaterThan(0);
  });

  it("the grenade preview flags a tall obstacle squarely in the throw arc", () => {
    const wall = createCover("w1", "Blast Wall", { x: 3.5, z: 0 }, { coverKind: "wall", height: 4.5, radius: 1.2, hp: 400 });
    const sim = new TacticalSim([
      createSoldier("p1", "Me", "player", { x: 0, z: 0 }),
      wall,
      createSoldier("e1", "Foe", "enemy", { x: 9, z: 0 }),
    ]);
    sim.select("p1");
    const target = sim.entity("e1")!;
    const preview = sim.previewGrenade("p1", "e1", target.parts[0].id);
    expect(preview).toBeTruthy();
    // The wall is in the path and too tall to clear, so the preview must not read as a clean throw.
    expect(preview!.blockedById ?? preview!.blockedByGround).toBeTruthy();
  });
});

describe("debug scenarios", () => {
  it("registers a non-trivial set of named scenarios", () => {
    expect(SCENARIO_IDS.length).toBeGreaterThanOrEqual(6);
    expect(SCENARIOS.every((s) => s.id && s.title && s.description)).toBe(true);
  });

  it("every scenario applies without error and leaves a populated battle", () => {
    for (const scenario of SCENARIOS) {
      const sim = new TacticalSim();
      expect(() => scenario.apply(sim)).not.toThrow();
      const combatants = sim.entities.filter((e) => e.kind !== "cover" && e.kind !== "base");
      expect(combatants.length, `scenario ${scenario.id}`).toBeGreaterThan(1);
    }
  });

  it("the roster scenario fields many distinct unit kinds", () => {
    const sim = new TacticalSim();
    applyScenario(sim, "roster");
    const kinds = new Set(sim.entities.filter((e) => e.team === "player" && e.kind !== "base").map((e) => e.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(8);
  });

  it("victory and defeat scenarios stage the matching end phase", () => {
    const v = new TacticalSim();
    applyScenario(v, "victory");
    expect(v.phase).toBe("victory");
    const d = new TacticalSim();
    applyScenario(d, "defeat");
    expect(d.phase).toBe("defeat");
  });

  it("the siege scenario fortifies the enemy base and stages a player assault", () => {
    const sim = new TacticalSim();
    applyScenario(sim, "siege");
    expect(sim.entities.some((e) => e.team === "enemy" && e.kind === "wall")).toBe(true);
    expect(sim.entities.some((e) => e.team === "player" && e.kind === "tank")).toBe(true);
  });

  it("debugSpawn/debugBuild place ready units that bypass the economy", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("ironworks"), "destroy", "normal");
    const before = sim.fieldUnitCount("player");
    const unit = sim.debugSpawn("artillery", "player", { x: 0, z: 0 });
    expect(unit.kind).toBe("artillery");
    expect(unit.commandPoints).toBe(unit.maxCommandPoints);
    expect(sim.fieldUnitCount("player")).toBe(before + 1);
    const wall = sim.debugBuild("wall", "player", { x: 2, z: 0 });
    expect(wall.kind).toBe("wall");
  });

  it("applyScenario returns false for an unknown id", () => {
    const sim = new TacticalSim();
    expect(applyScenario(sim, "does-not-exist")).toBe(false);
  });
});
