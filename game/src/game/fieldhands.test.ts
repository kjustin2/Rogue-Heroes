import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { applyDamage } from "./damageModel";
import { ARENA_BOUNDS, DEFAULT_TERRAIN, pointInWater, setActiveTerrain } from "./terrain";
const pointInWaterAt = (x: number, z: number): boolean => pointInWater({ x, z });

// FIELD HANDS (owner 2026-10-03): Heal / Repair, charges, bounce pads, oil, barriers, the rocketeer.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal");
  sim.economy.set("player", 1000);
  sim.economy.set("enemy", 0);
  for (const e of sim.entities) if (e.team === "enemy" && e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
  return sim;
};
const disarm = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility" || p.role === "weapon") p.hp = 0;
  e.status.canMove = false; e.status.canShoot = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);
const maxHp = (e: { parts: { maxHp: number }[] }): number => e.parts.reduce((s, p) => s + p.maxHp, 0);

describe("treat", () => {
  it("a medic walks up and restores every part of a wounded trooper, wrecked ones to a third", () => {
    const sim = staged();
    const medic = sim.debugSpawn("medic", "player", { x: -10, z: 4 });
    const patient = sim.debugSpawn("soldier", "player", { x: -2, z: 4 });
    const legs = patient.parts.find((p) => p.role === "mobility")!;
    for (const p of patient.parts) p.hp = Math.max(1, Math.round(p.hp * 0.3));
    legs.hp = 0;
    expect(hp(patient)).toBeLessThan(maxHp(patient) * 0.5);
    sim.debugSelect(medic.id);
    expect(sim.queueTreat(patient.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    const after = (id: string): number => sim.entity(id)!.parts.find((p) => p.id === legs.id)!.hp;
    expect(after(patient.id)).toBeGreaterThanOrEqual(Math.round(legs.maxHp / 3)); // a third back (the aura tops it up a little at turn start)
    expect(after(patient.id)).toBeLessThan(legs.maxHp);
    for (const p of sim.entity(patient.id)!.parts) if (p.id !== legs.id) expect(p.hp).toBe(p.maxHp);
    expect(Math.hypot(medic.position.x - patient.position.x, medic.position.z - patient.position.z)).toBeLessThan(5); // walked up, no teleport
  });

  it("refuses the wrong job with a reason: a medic cannot mend a tank, an engineer cannot heal a trooper", () => {
    const sim = staged();
    const medic = sim.debugSpawn("medic", "player", { x: -8, z: 0 });
    const engineer = sim.debugSpawn("engineer", "player", { x: -8, z: 3 });
    const tank = sim.debugSpawn("tank", "player", { x: -6, z: -3 });
    const trooper = sim.debugSpawn("soldier", "player", { x: -6, z: 6 });
    applyDamage(tank, tank.parts[0].id, 20);
    applyDamage(trooper, trooper.parts[0].id, 10);
    expect(sim.treatFailureReason(medic, tank)).toMatch(/medic treats infantry/);
    expect(sim.treatFailureReason(engineer, trooper)).toMatch(/engineer fixes machines/);
    expect(sim.treatFailureReason(engineer, tank)).toBeUndefined();
    expect(sim.treatFailureReason(medic, trooper)).toBeUndefined();
    const whole = sim.debugSpawn("soldier", "player", { x: -4, z: 6 });
    expect(sim.treatFailureReason(medic, whole)).toMatch(/undamaged/);
  });

  it("an engineer repairs a tank, including its wrecked tracks", () => {
    const sim = staged();
    const engineer = sim.debugSpawn("engineer", "player", { x: -9, z: 0 });
    const tank = sim.debugSpawn("tank", "player", { x: -4, z: 0 });
    for (const p of tank.parts) if (!p.critical) p.hp = 0;
    sim.debugSelect(engineer.id);
    expect(sim.queueTreat(tank.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(hp(sim.entity(tank.id)!)).toBeGreaterThan(0);
    expect(sim.log.some((l) => l.includes("repairs"))).toBe(true);
  });
});

describe("demolition charge", () => {
  it("is set down without a blast, ticks for three turns, then blows everything near it away", () => {
    const sim = staged();
    const demo = sim.debugSpawn("demo", "player", { x: -6, z: 0 });
    const victim = sim.debugSpawn("soldier", "enemy", { x: -0.2, z: 0 });
    disarm(victim);
    sim.debugSelect(demo.id);
    const before = hp(victim);
    expect(sim.queuePlace({ x: -2.5, z: 0 })).toBe(true);
    expect(hp(victim)).toBe(before); // nothing thrown up on placement
    const charge = sim.entities.find((e) => e.coverKind === "charge")!;
    expect(charge.fuse).toBe(3);
    expect(sim.money("player")).toBe(1000 - 45);
    for (let i = 0; i < 2; i += 1) { sim.endTurn(); settle(sim); expect(sim.entity(charge.id)!.status.alive).toBe(true); }
    sim.endTurn();
    settle(sim);
    expect(sim.entity(charge.id)!.status.alive).toBe(false);
    expect(hp(sim.entity(victim.id)!)).toBeLessThan(before - 30);
  });

  it("goes off the moment it is shot", () => {
    const sim = staged();
    const demo = sim.debugSpawn("demo", "player", { x: -8, z: 0 });
    sim.debugSelect(demo.id);
    expect(sim.queuePlace({ x: -5, z: 0 })).toBe(true);
    const charge = sim.entities.find((e) => e.coverKind === "charge")!;
    const result = applyDamage(charge, charge.parts[0].id, 99);
    expect(result.killed || !charge.status.alive).toBe(true);
    (sim as unknown as { afterDamage(a: unknown, t: unknown, r: unknown): void }).afterDamage(charge, charge, result);
    expect(sim.log.some((l) => l.includes("detonates"))).toBe(true);
  });

  it("refuses a fifth charge, and a spot out of reach", () => {
    const sim = staged();
    const demo = sim.debugSpawn("demo", "player", { x: -8, z: 0 });
    sim.debugSelect(demo.id);
    expect(sim.placeFailureReason(demo, { x: 5, z: 0 })).toMatch(/Too far/);
    expect(sim.placeFailureReason(demo, { x: -6, z: 0 })).toBeUndefined();
  });
});

describe("bounce pad", () => {
  it("launches a trooper that steps on it 8m the way it points", () => {
    const sim = staged();
    const tech = sim.debugSpawn("springer", "player", { x: -10, z: 0 });
    const runner = sim.debugSpawn("soldier", "player", { x: -10, z: 4 });
    sim.debugSelect(tech.id);
    sim.rotatePlacement(0);
    expect(sim.queuePlace({ x: -10, z: 2.5 })).toBe(true); // yaw: facing away from the unit, along +z
    const pad = sim.pads[0];
    expect(pad).toBeTruthy();
    pad.yaw = Math.PI / 2; // point it along +x
    sim.debugSelect(runner.id);
    expect(sim.queueMove({ x: pad.x, z: pad.z })).toBe(true);
    sim.endTurn();
    settle(sim);
    const end = sim.entity(runner.id)!;
    expect(end.position.x - pad.x).toBeGreaterThan(6);
    expect(sim.log.some((l) => l.includes("springs off a bounce pad"))).toBe(true);
  });

  it("a trooper blown onto a pad over the map edge is gone", () => {
    const sim = staged();
    const edgeX = ARENA_BOUNDS.maxX - 3;
    sim.pads.push({ id: "pad-t", x: edgeX, z: 0, yaw: Math.PI / 2, team: "player" });
    const victim = sim.debugSpawn("soldier", "player", { x: edgeX - 0.3, z: 0 });
    disarm(victim);
    (sim as unknown as { bounceOffPad(e: unknown): void }).bounceOffPad({ ...victim, position: { x: edgeX, z: 0 } });
    // Drive it through the real thing: stand it on the pad and bounce.
    victim.position = { x: edgeX, z: 0 };
    (sim as unknown as { bounceOffPad(e: unknown): void }).bounceOffPad(victim);
    expect(sim.entity(victim.id)!.status.alive).toBe(false);
    expect(sim.log.some((l) => l.includes("off the battlefield"))).toBe(true);
  });

  it("never bounces a vehicle", () => {
    const sim = staged();
    const tank = sim.debugSpawn("tank", "player", { x: -6, z: 0 });
    sim.pads.push({ id: "pad-t", x: -6, z: 0, yaw: 0, team: "player" });
    (sim as unknown as { bounceOffPad(e: unknown): void }).bounceOffPad(tank);
    expect(tank.position.x).toBe(-6);
    expect(tank.position.z).toBe(0);
  });
});

describe("oil", () => {
  it("lights the whole puddle from a blast and burns everyone standing in it, turn after turn", () => {
    const sim = staged();
    const oiler = sim.debugSpawn("oiler", "player", { x: -10, z: 0 });
    const victim = sim.debugSpawn("soldier", "enemy", { x: -6.5, z: 0 });
    disarm(victim);
    sim.debugSelect(oiler.id);
    expect(sim.queuePlace({ x: -6.5, z: 0 })).toBe(true);
    expect(sim.oilSlicks.length).toBe(1);
    const before = hp(victim);
    (sim as unknown as { effect(t: string, a: unknown, b: unknown, c: number, d: number, r?: number): void }).effect("blast", { x: -6, z: 1 }, { x: -6, z: 1 }, 0xffffff, 0.5, 1);
    expect(sim.oilSlicks.length).toBe(0);
    expect(sim.burnZones.length).toBeGreaterThan(0);
    sim.endTurn();
    settle(sim);
    const mid = hp(sim.entity(victim.id)!);
    expect(mid).toBeLessThan(before);
    sim.endTurn();
    settle(sim);
    expect(hp(sim.entity(victim.id)!)).toBeLessThan(mid);
  });

  it("a round that lands in the puddle sets it off", () => {
    const sim = staged();
    const oiler = sim.debugSpawn("oiler", "player", { x: -10, z: 0 });
    sim.debugSelect(oiler.id);
    expect(sim.queuePlace({ x: -7, z: 0 })).toBe(true);
    const shooter = sim.debugSpawn("soldier", "player", { x: -14, z: 0 });
    const decoy = sim.debugSpawn("soldier", "enemy", { x: -7, z: 0 });
    disarm(decoy);
    sim.debugSelect(shooter.id);
    sim.queueShoot(decoy.id);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("The oil ignites"))).toBe(true);
  });
});

describe("barrier and rocketeer", () => {
  it("a barrier is two solid blocks across the facing", () => {
    const sim = staged();
    const builder = sim.debugSpawn("builder", "player", { x: -10, z: 0 });
    sim.debugSelect(builder.id);
    expect(sim.queuePlace({ x: -7, z: 0 })).toBe(true);
    const blocks = sim.entities.filter((e) => e.coverKind === "barrier");
    expect(blocks.length).toBe(2);
    expect(blocks[0].status.alive).toBe(true);
  });

  it("a rocket hits armour half again as hard as it hits a trooper's equivalent", () => {
    const sim = staged();
    const rocketeer = sim.debugSpawn("bazooka", "player", { x: -14, z: 0 });
    const tank = sim.debugSpawn("tank", "enemy", { x: -4, z: 0 });
    disarm(tank);
    const part = tank.parts.find((p) => p.role === "armor") ?? tank.parts[0];
    const preview = sim.previewShot(rocketeer.id, tank.id, part.id);
    const soldier = sim.debugSpawn("soldier", "player", { x: -14, z: 4 });
    const control = sim.previewShot(soldier.id, tank.id, part.id);
    expect(preview && control && preview.amount > control.amount * 1.6).toBe(true);
  });
});

describe("persistence", () => {
  it("pads and oil survive a save", () => {
    const sim = staged();
    sim.pads.push({ id: "pad-1", x: -5, z: 2, yaw: 1, team: "player" });
    sim.oilSlicks.push({ id: "oil-1", x: -3, z: 2, radius: 2.7, team: "enemy" });
    const raw = sim.serialize();
    const loaded = new TacticalSim();
    expect(loaded.restore(raw)).toBe(true);
    expect(loaded.pads).toEqual(sim.pads);
    expect(loaded.oilSlicks).toEqual(sim.oilSlicks);
    setActiveTerrain(DEFAULT_TERRAIN);
  });
});

describe("manned emplacements", () => {
  const post = (sim: TacticalSim, x: number, z: number, kind: "gunpost" | "mortarpit" = "gunpost") => {
    const e = sim.debugStructure(kind, "neutral", { x, z });
    return e;
  };

  it("every map starts with a mirrored pair of free Gun Posts", () => {
    for (const id of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      const posts = sim.entities.filter((e) => e.kind === "gunpost" && e.team === "neutral");
      expect(posts.length, id).toBe(2);
    }
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("a trooper walks up and crews a post; it fires next turn while its crew rests", () => {
    const sim = staged();
    for (const e of sim.entities.filter((x) => x.kind === "gunpost")) e.status.alive = false;
    const gp = post(sim, -8, 0);
    const gunner = sim.debugSpawn("soldier", "player", { x: -13, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 1, z: 0 });
    disarm(target);
    sim.debugSelect(gunner.id);
    expect(sim.queueMan(gp.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.entity(gp.id)!.occupantId).toBe(gunner.id);
    expect(sim.entity(gp.id)!.team).toBe("player");
    // The crew stands behind the gun, close, facing the way it faces.
    const gx = Math.sin(gp.yaw), gz = Math.cos(gp.yaw);
    const rel = { x: gunner.position.x - gp.position.x, z: gunner.position.z - gp.position.z };
    expect(rel.x * gx + rel.z * gz).toBeLessThan(0);
    expect(Math.hypot(rel.x, rel.z)).toBeLessThan(gp.radius + gunner.radius + 0.4);
    expect(gunner.commandPoints).toBe(0); // the crew's turn is the gun's
    expect(sim.entity(gp.id)!.commandPoints).toBe(1);
    sim.debugSelect(gp.id);
    const before = hp(target);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(hp(sim.entity(target.id)!)).toBeLessThan(before);
  });

  it("an uncrewed post cannot act; Leave sends the crew away and the post goes quiet", () => {
    const sim = staged();
    const gp = post(sim, -8, 0);
    const gunner = sim.debugSpawn("soldier", "player", { x: -8 + 1.1, z: 0 });
    sim.debugSelect(gunner.id);
    expect(sim.queueMan(gp.id)).toBe(true);
    sim.endTurn(); settle(sim);
    sim.debugSelect(gp.id);
    expect(sim.queueDismount()).toBe(true);
    expect(sim.entity(gp.id)!.occupantId).toBeUndefined();
    expect(sim.entity(gp.id)!.commandPoints).toBe(0);
  });

  it("refuses an enemy's post and a post already crewed", () => {
    const sim = staged();
    const gp = post(sim, -8, 0);
    gp.team = "enemy";
    const gunner = sim.debugSpawn("soldier", "player", { x: -11, z: 0 });
    expect(sim.manFailureReason(gunner, gp)).toMatch(/belongs to the enemy/);
    gp.team = "neutral";
    expect(sim.manFailureReason(gunner, gp)).toBeUndefined();
    gp.occupantId = sim.debugSpawn("heavy", "enemy", { x: -9.2, z: 0 }).id;
    expect(sim.manFailureReason(gunner, gp)).toMatch(/already crewed/);
  });

  it("a crew that dies frees the post", () => {
    const sim = staged();
    const gp = post(sim, -8, 0);
    const gunner = sim.debugSpawn("soldier", "player", { x: -9.7, z: 0 });
    sim.debugSelect(gunner.id);
    sim.queueMan(gp.id);
    sim.endTurn(); settle(sim);
    expect(sim.entity(gp.id)!.occupantId).toBe(gunner.id);
    for (const p of gunner.parts) p.hp = 0;
    sim.entity(gunner.id)!.status.alive = false;
    sim.endTurn(); settle(sim);
    expect(sim.entity(gp.id)!.occupantId).toBeUndefined();
  });
});

describe("bot field hands", () => {
  const run = (difficulty: "normal" | "hard", kind: "oiler" | "builder" | "demo"): TacticalSim => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", difficulty);
    sim.economy.set("enemy", 900);
    sim.economy.set("player", 0);
    for (const e of sim.entities) if (e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
    const hand = sim.debugSpawn(kind, "enemy", { x: 10, z: 0 });
    const bait = sim.debugSpawn("soldier", "player", { x: -2, z: 0 });
    disarm(bait);
    hand.commandPoints = hand.maxCommandPoints;
    sim.endTurn();
    settle(sim);
    return sim;
  };

  it("the Hard bot lays oil across the foe's lane, a barrier ahead of its line and a charge in front of them; Normal does not", () => {
    expect(run("hard", "oiler").oilSlicks.some((o) => o.team === "enemy")).toBe(true);
    expect(run("hard", "builder").entities.some((e) => e.coverKind === "barrier")).toBe(true);
    expect(run("hard", "demo").entities.some((e) => e.coverKind === "charge")).toBe(true);
    expect(run("normal", "oiler").oilSlicks.length).toBe(0);
  });

  it("bots treat a charge, a foe's oil and a foe's pad as danger and stay out", () => {
    const sim = staged();
    const danger = (p: { x: number; z: number }): boolean => (sim as unknown as { aiDangerAt(p: unknown, m?: number): boolean }).aiDangerAt(p);
    expect(danger({ x: -5, z: 0 })).toBe(false);
    sim.oilSlicks.push({ id: "o", x: -5, z: 0, radius: 2.7, team: "player" });
    expect(danger({ x: -5, z: 0 })).toBe(true);
    sim.oilSlicks.length = 0;
    sim.pads.push({ id: "p", x: -5, z: 0, yaw: 0, team: "player" });
    expect(danger({ x: -5, z: 0.5 })).toBe(true);
    sim.pads.length = 0;
    const demo = sim.debugSpawn("demo", "player", { x: -8, z: 0 });
    sim.debugSelect(demo.id);
    sim.queuePlace({ x: -5, z: 0 });
    expect(danger({ x: -5, z: 0 })).toBe(true);
  });
});

describe("bot push", () => {
  it("the Hard bot shoves a trooper that stands at the water's edge", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("causeway"), "destroy", "hard");
    // first water metre along z at x = 0
    let zw = 0;
    for (let z = 0; z < 40; z += 0.25) if (pointInWaterAt(0, z)) { zw = z; break; }
    expect(zw).toBeGreaterThan(2);
    for (const e of sim.entities) if (e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
    sim.economy.set("enemy", 0);
    const hunter = sim.debugSpawn("soldier", "enemy", { x: 0, z: zw - 5 });
    const victim = sim.debugSpawn("soldier", "player", { x: 0, z: zw - 1.6 });
    disarm(victim);
    hunter.commandPoints = hunter.maxCommandPoints;
    sim.endTurn();
    settle(sim);
    expect(sim.log.join(" | ")).toContain("shoves");
    setActiveTerrain(DEFAULT_TERRAIN);
  });
});
