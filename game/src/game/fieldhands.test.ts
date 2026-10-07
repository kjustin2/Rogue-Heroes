import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, pointInWater, setActiveTerrain } from "./terrain";
const pointInWaterAt = (x: number, z: number): boolean => pointInWater({ x, z });

// FIELD HANDS (owner 2026-10-03): charges, barriers, the rocketeer, manned posts.
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

describe("barrier and rocketeer", () => {

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
    expect(gunner.commandPoints).toBe(1); // the crew keeps one action, only for leaving
    expect(sim.entity(gp.id)!.commandPoints).toBe(2); // the gun gets two shots
    sim.debugSelect(gp.id);
    const before = hp(target);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(hp(sim.entity(target.id)!)).toBeLessThan(before);
  });

  it("a crewed post hits a foe right beside it, from every side (the crew is never in the way)", () => {
    for (const [dx, dz] of [[1.7, 0], [-1.7, 0], [0, 1.7], [0, -1.7], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]] as const) {
      const sim = staged();
      for (const e of sim.entities.filter((x) => x.kind === "gunpost")) e.status.alive = false;
      const gp = post(sim, -8, 0);
      const gunner = sim.debugSpawn("soldier", "player", { x: -8 - 1.1, z: 0 });
      sim.debugSelect(gunner.id);
      expect(sim.queueMan(gp.id)).toBe(true);
      sim.endTurn(); settle(sim);
      const target = sim.debugSpawn("soldier", "enemy", { x: gp.position.x + dx, z: gp.position.z + dz });
      disarm(target);
      sim.debugSelect(gp.id);
      expect(sim.previewShot(gp.id, target.id, target.parts[0].id)?.warningText, `no friendly-fire warning ${dx},${dz}`).toBeUndefined();
      const before = hp(target);
      expect(sim.queueShoot(target.id), `queue ${dx},${dz}`).toBe(true);
      sim.endTurn(); settle(sim);
      expect(hp(sim.entity(target.id)!), `damage ${dx},${dz}`).toBeLessThan(before);
      expect(hp(sim.entity(gunner.id)!), `crew untouched ${dx},${dz}`).toBe(hp(gunner));
    }
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("a crewed post gets two actions a turn and the crew keeps one, spent only on leaving", () => {
    const sim = staged();
    const gp = post(sim, -8, 0);
    const gunner = sim.debugSpawn("soldier", "player", { x: -9.1, z: 0 });
    sim.debugSelect(gunner.id);
    sim.queueMan(gp.id);
    sim.endTurn(); settle(sim);
    expect(sim.entity(gp.id)!.commandPoints).toBe(2);
    expect(gunner.commandPoints).toBe(1);
    sim.debugSelect(gp.id);
    expect(sim.queueDismount()).toBe(true);
    expect(gunner.commandPoints).toBe(0); // leaving costs the crew's one action
    expect(sim.entity(gp.id)!.occupantId).toBeUndefined();
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

describe("bot push", () => {
  it("the Hard bot shoves a trooper that stands at the water's edge", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("causeway"), "destroy", "hard");
    // first water metre along z at x = -6 (x = 0 crosses the channel's ice strip since 2026-10-07)
    const X = -6;
    let zw = 0;
    for (let z = 0; z < 40; z += 0.25) if (pointInWaterAt(X, z)) { zw = z; break; }
    expect(zw).toBeGreaterThan(2);
    for (const e of sim.entities) if (e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
    sim.economy.set("enemy", 0);
    const hunter = sim.debugSpawn("soldier", "enemy", { x: X, z: zw - 5 });
    const victim = sim.debugSpawn("soldier", "player", { x: X, z: zw - 1.6 });
    disarm(victim);
    hunter.commandPoints = hunter.maxCommandPoints;
    sim.endTurn();
    settle(sim);
    expect(sim.log.join(" | ")).toContain("shoves");
    setActiveTerrain(DEFAULT_TERRAIN);
  });
});

describe("explosion knockback", () => {
  it("a rocket that hits a trooper throws it backwards, away from the shooter; a tank hit stays put", () => {
    const run = (targetKind: "soldier" | "tank"): number => {
      const sim = staged();
      const r = sim.debugSpawn("bazooka", "player", { x: -14, z: 0 });
      const t = sim.debugSpawn(targetKind, "enemy", { x: -6, z: 0 });
      disarm(t);
      sim.debugSelect(r.id);
      const part = t.parts.find((p) => p.role === "armor") ?? t.parts.find((p) => p.id === "body") ?? t.parts[0];
      sim.queueShootPart(t.id, part.id);
      sim.endTurn();
      settle(sim);
      const after = sim.entity(t.id)!;
      return after.position.x - -6;
    };
    expect(run("soldier")).toBeGreaterThan(1.2); // thrown away from the shooter (+x)
    expect(Math.abs(run("tank"))).toBeLessThan(0.8);
  });
});
