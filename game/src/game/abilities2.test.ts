import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round two (unit-identity picks 2, 6, 7):
// sniper MARK, mortar SMOKE round, medic STABILISE.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => { const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal"); return sim; };
// The enemy AI moves and shoots its units during the resolve; take their legs and weapon so the
// staging stays where it was put.
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);
const core = (e: ReturnType<TacticalSim["debugSpawn"]>) => e.parts.find((p) => p.role === "core")!;

describe("mortar smoke round", () => {
  it("lands a 3-turn cloud that blocks flat shots (not arcing ones) and shrinks away", () => {
    const sim = staged();
    const mortar = sim.debugSpawn("mortar", "player", { x: -8, z: 0 });
    const rifle = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    disarm(target);
    sim.debugSelect(mortar.id);
    expect(sim.queueSmokeAt({ x: 2, z: 0 })).toBe(true);
    expect(mortar.commandPoints).toBe(mortar.maxCommandPoints - 1);
    sim.endTurn();
    settle(sim);
    expect(sim.smokeClouds.length).toBe(1);
    expect(sim.smokeClouds[0]).toMatchObject({ radius: 3, turnsLeft: 2 }); // one turn start has already ticked it
    expect(Math.hypot(sim.smokeClouds[0].x - 2, sim.smokeClouds[0].z)).toBeLessThan(0.5);
    expect(sim.log.some((l) => l.includes("smoke round blooms"))).toBe(true);
    expect(hp(target)).toBe(target.parts.reduce((s, p) => s + p.maxHp, 0) - target.parts.filter((p) => p.role === "mobility" || p.role === "weapon").reduce((s, p) => s + p.maxHp, 0)); // smoke harms nothing

    // A flat rifle shot whose line crosses the cloud is blocked in the preview and refused as an order.
    const preview = sim.previewShot(rifle.id, target.id, core(target).id)!;
    expect(preview.blockedBySmoke).toBe(true);
    expect(preview.amount).toBe(0);
    sim.debugSelect(rifle.id);
    expect(sim.queueShoot(target.id)).toBe(false);
    expect(sim.log.some((l) => l.includes("hidden by smoke"))).toBe(true);
    // The mortar's own arcing round sails over it.
    const arc = sim.previewShot(mortar.id, target.id, core(target).id)!;
    expect(arc.blockedBySmoke).toBe(false);
    sim.debugSelect(mortar.id);
    expect(sim.queueShootAt({ x: 8, z: 0 })).toBe(true);

    // Clouds last three turn starts, then vanish.
    sim.endTurn(); settle(sim);
    expect(sim.smokeClouds[0]?.turnsLeft).toBe(1);
    sim.endTurn(); settle(sim);
    expect(sim.smokeClouds.length).toBe(0);
  });

  it("swallows a flat round already in flight", () => {
    const sim = staged();
    const rifle = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });
    disarm(target);
    const before = hp(target);
    sim.debugSelect(rifle.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    // The cloud appears after the order is given (a mortar round from elsewhere would do this).
    sim.smokeClouds.push({ id: "smoke-test", x: 1, z: 0, radius: 3, turnsLeft: 3 });
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("lost in the smoke"))).toBe(true);
    expect(hp(target)).toBe(before);
  });

  it("is a mortar-only order that survives a save/restore round trip", () => {
    const sim = staged();
    const soldier = sim.debugSpawn("soldier", "player", { x: -4, z: 0 });
    sim.debugSelect(soldier.id);
    expect(sim.queueSmokeAt({ x: 0, z: 0 })).toBe(false);
    sim.smokeClouds.push({ id: "smoke-1", x: 3, z: 2, radius: 3, turnsLeft: 2 });
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    expect(copy.smokeClouds).toEqual(sim.smokeClouds);
  });
});

describe("medic stabilise", () => {
  it("a killing blow with a medic in reach leaves the trooper DOWN, and the medic revives it next turn", () => {
    const sim = staged();
    const medic = sim.debugSpawn("medic", "player", { x: 0, z: 0 });
    const victim = sim.debugSpawn("soldier", "player", { x: 3, z: 0 });
    const enemy = sim.debugSpawn("soldier", "enemy", { x: 20, z: 20 });
    disarm(enemy);
    sim.debugDamage(victim.id, core(victim).id, 999, enemy.id);
    expect(victim.downed).toBe(true);
    expect(victim.status.alive).toBe(true);
    expect(victim.status.canMove).toBe(false);
    expect(victim.status.canShoot).toBe(false);
    expect(core(victim).hp).toBe(1);
    expect(sim.log.some((l) => l.includes("is down — a medic can still reach them"))).toBe(true);
    expect(sim.playerLosses).toBe(0);
    // A downed body is not a target and takes no splash.
    sim.debugSelect(enemy.id);
    expect(sim.queueShoot(victim.id)).toBe(false);
    sim.endTurn();
    settle(sim);
    expect(victim.downed).toBe(false);
    expect(victim.status.alive).toBe(true);
    expect(core(victim).hp).toBe(Math.round(core(victim).maxHp * 0.3));
    expect(victim.status.canMove).toBe(true);
    expect(sim.log.some((l) => l.includes("is back on their feet"))).toBe(true);
    expect(medic.status.alive).toBe(true);
  });

  it("dies for real at the turn start if no medic is in reach, and outright with no medic nearby", () => {
    const sim = staged();
    const medic = sim.debugSpawn("medic", "player", { x: 0, z: 0 });
    const victim = sim.debugSpawn("soldier", "player", { x: 3, z: 0 });
    const enemy = sim.debugSpawn("soldier", "enemy", { x: 20, z: 20 });
    disarm(enemy);
    sim.debugDamage(victim.id, core(victim).id, 999, enemy.id);
    expect(victim.downed).toBe(true);
    medic.position = { x: 15, z: 15 }; // the medic is pulled away before the turn ends
    sim.endTurn();
    settle(sim);
    expect(victim.downed).toBe(false);
    expect(victim.status.alive).toBe(false);
    expect(sim.log.some((l) => l.includes("no medic reached them"))).toBe(true);
    expect(sim.playerLosses).toBe(1);

    // No medic within 6: the ordinary death.
    const sim2 = staged();
    sim2.debugSpawn("medic", "player", { x: -10, z: 0 });
    const victim2 = sim2.debugSpawn("soldier", "player", { x: 3, z: 0 });
    const enemy2 = sim2.debugSpawn("soldier", "enemy", { x: 20, z: 20 });
    sim2.debugDamage(victim2.id, core(victim2).id, 999, enemy2.id);
    expect(victim2.downed).toBeUndefined();
    expect(victim2.status.alive).toBe(false);
  });

  it("rides serialize/restore", () => {
    const sim = staged();
    sim.debugSpawn("medic", "player", { x: 0, z: 0 });
    const victim = sim.debugSpawn("soldier", "player", { x: 3, z: 0 });
    const enemy = sim.debugSpawn("soldier", "enemy", { x: 20, z: 20 });
    sim.debugDamage(victim.id, core(victim).id, 999, enemy.id);
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    expect(copy.entities.find((e) => e.id === victim.id)?.downed).toBe(true);
  });
});

describe("sniper mark", () => {
  it("a sniper's shot paints the target for the rest of the turn; other friendlies aim tighter", () => {
    const sim = staged();
    const sniper = sim.debugSpawn("sniper", "player", { x: -10, z: 0 });
    const rifle = sim.debugSpawn("soldier", "player", { x: -6, z: 3 });
    const target = sim.debugSpawn("heavy", "enemy", { x: 8, z: 0 });
    disarm(target);
    const unmarked = sim.previewShot(rifle.id, target.id, core(target).id)!;
    sim.debugSelect(sniper.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    // The mark is stamped at fire time and lasts through the next command phase.
    expect(sim.log.some((l) => l.includes("is marked"))).toBe(true);
    expect(target.markedUntilTurn).toBe(sim.turn);
    expect(target.markedById).toBe(sniper.id);
    expect(sim.isMarkedFor(rifle, target)).toBe(true);
    expect(sim.isMarkedFor(sniper, target)).toBe(false); // the marker gets nothing from its own mark
    const marked = sim.previewShot(rifle.id, target.id, core(target).id)!;
    expect(marked.spreadDegrees).toBeLessThan(unmarked.spreadDegrees);
    expect(marked.hitChance).toBeGreaterThan(unmarked.hitChance);
    expect(marked.accuracyNotes).toContain("marked target");
    // It clears at the turn after.
    sim.endTurn();
    settle(sim);
    expect(target.markedUntilTurn).toBeUndefined();
    expect(sim.previewShot(rifle.id, target.id, core(target).id)!.accuracyNotes).not.toContain("marked target");
  });

  it("marks on a miss too, and survives a save/restore round trip", () => {
    const sim = staged();
    const sniper = sim.debugSpawn("sniper", "player", { x: -10, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    disarm(target);
    const before = hp(target);
    sim.debugSelect(sniper.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(target.markedUntilTurn).toBe(sim.turn); // whether or not the round connected
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    const restored = copy.entities.find((e) => e.id === target.id)!;
    expect(restored.markedUntilTurn).toBe(target.markedUntilTurn);
    expect(restored.markedById).toBe(sniper.id);
    expect(hp(target)).toBeLessThanOrEqual(before);
  });
});
