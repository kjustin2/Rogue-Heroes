import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round four (docs/unit-identity-ideas.md picks 5, 9, 10, 14, 15, 17, 18):
// grenadier AIRBURST, flamer FEAR, drone op RECON, APC CARRY, artillery DEPLOY, gunship STRAFE,
// bomber CARPET.
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

describe("grenadier airburst", () => {
  it("a round that bursts on cover still lands half its damage on the trooper behind it", () => {
    const sim = staged();
    const grenadier = sim.debugSpawn("grenadier", "player", { x: -18, z: 0 });
    const wall = sim.debugCover("pillar", { x: 0, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: wall.radius + 0.8, z: 0 });
    disarm(target);
    target.stance = "crouched";
    const before = hp(target);
    sim.debugSelect(grenadier.id);
    expect(sim.queueShoot(target.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("bursts near Stone Pillar"))).toBe(true); // the round DID hit the wall
    expect(sim.log.some((l) => l.includes("airbursts"))).toBe(true);
    expect(before - hp(target)).toBeGreaterThanOrEqual(12);
  });
});

describe("flamer fear", () => {
  it("enemy infantry beside burning ground run from it, where the same trooper otherwise advances through it", () => {
    const run = (burning: boolean): number => {
      const sim = staged();
      const bait = sim.debugSpawn("soldier", "player", { x: -14, z: 0 });
      disarm(bait);
      const trooper = sim.debugSpawn("soldier", "enemy", { x: 4, z: 0 });
      // The fire sits between the trooper and the player, 3m out (FLAMER_FEAR_RADIUS is 6).
      if (burning) sim.burnZones.push({ id: "burn-test", x: 1, z: 0, radius: 1.6, turnsLeft: 3 });
      sim.endTurn();
      settle(sim);
      expect(sim.log.some((l) => l.includes("runs from the fire"))).toBe(burning);
      return trooper.position.x;
    };
    expect(run(true)).toBeGreaterThan(6); // fled away from the flames (+x)
    expect(run(false)).toBeLessThan(2); // control: pressed the player (-x), straight past the spot
  });
});

describe("drone op recon pulse", () => {
  it("costs the whole turn, reveals the enemy's next orders exactly as they are then issued, and leaves the rng untouched", () => {
    const sim = staged();
    const op = sim.debugSpawn("droneop", "player", { x: -10, z: 0 });
    const enemy = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    // A plain soldier cannot pulse; the drone op can, and it takes every command point.
    const soldier = sim.debugSpawn("soldier", "player", { x: -10, z: 3 });
    sim.debugSelect(soldier.id);
    expect(sim.queueRecon()).toBe(false);
    expect(sim.enemyIntents()).toEqual([]); // nothing revealed yet
    sim.debugSelect(op.id);
    expect(sim.queueRecon()).toBe(true);
    expect(op.commandPoints).toBe(0);
    sim.endTurn();
    settle(sim);
    expect(sim.revealedOrders).toBe(true);
    expect(sim.log.some((l) => l.includes("next orders are revealed"))).toBe(true);

    // Command phase: the enemy's plan is readable, the preview changed nothing, and it is stable.
    const before = sim.serialize();
    const intents = sim.enemyIntents();
    expect(intents.length).toBeGreaterThan(0);
    expect(intents.some((i) => i.actorId === enemy.id)).toBe(true);
    expect(sim.serialize()).toBe(before);
    expect(sim.enemyIntents()).toEqual(intents);
    // The reveal rides a save/restore round trip.
    const copy = new TacticalSim();
    expect(copy.restore(before)).toBe(true);
    expect(copy.revealedOrders).toBe(true);
    // (the rng stream itself is not saved, so a restored copy may roll a different aim — the
    // actors it plans for are the same)
    expect(copy.enemyIntents().map((i) => i.actorId)).toEqual(intents.map((i) => i.actorId));

    // The real command matches the preview order-for-order, then the reveal is spent.
    sim.endTurn();
    const issued = sim.orders.filter((o) => o.actorId !== op.id && o.actorId !== soldier.id).map((o) => ({ actorId: o.actorId, kind: o.kind, destination: o.destination, targetId: o.targetId }));
    expect(issued).toEqual(intents);
    expect(sim.revealedOrders).toBe(false);
    settle(sim);
    expect(sim.enemyIntents()).toEqual([]);
  });
});

describe("apc carry", () => {
  it("takes an adjacent trooper aboard (not a distant one), drives it, sets it down beside itself, and drops it on death", () => {
    const sim = staged();
    const apc = sim.debugSpawn("apc", "player", { x: -10, z: 0 });
    const near = sim.debugSpawn("soldier", "player", { x: -10 + apc.radius + 0.9, z: 0 });
    const far = sim.debugSpawn("soldier", "player", { x: -10, z: 6 });
    sim.debugSelect(apc.id);
    expect(sim.queueLoad(far.id)).toBe(false); // must be beside the hull
    expect(sim.log[0]).toContain("must be beside the APC");
    expect(sim.queueLoad(near.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(near.carriedById).toBe(apc.id);
    expect(apc.passengerIds).toEqual([near.id]);

    // The passenger rides along, hidden from targeting and separation.
    sim.debugSelect(apc.id);
    expect(sim.queueMove({ x: -2, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(apc.position.x).toBeGreaterThan(-6);
    expect(near.position).toEqual(apc.position);
    expect(near.carriedById).toBe(apc.id);

    // Unload is beside the hull only, and the ramp drops where the APC stands.
    sim.debugSelect(apc.id);
    expect(sim.queueUnload({ x: apc.position.x + 12, z: 0 })).toBe(false);
    expect(sim.queueUnload({ x: apc.position.x + 2, z: 0 })).toBe(true);
    const parked = { ...apc.position };
    sim.endTurn();
    settle(sim);
    expect(near.carriedById).toBeUndefined();
    expect(apc.passengerIds).toEqual([]);
    expect(Math.hypot(near.position.x - parked.x, near.position.z - parked.z)).toBeLessThan(5);

    // Cargo bails out when the APC dies.
    sim.debugSelect(apc.id);
    expect(sim.queueLoad(near.id)).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(near.carriedById).toBe(apc.id);
    for (const p of apc.parts) p.hp = 0;
    apc.status.alive = false;
    sim.endTurn();
    settle(sim);
    expect(near.carriedById).toBeUndefined();
    expect(near.status.alive).toBe(true);
    expect(sim.log.some((l) => l.includes("bails out"))).toBe(true);
  });
});

describe("artillery deploy", () => {
  it("cannot fire until deployed, deploys by holding still or by order, and packing up to move costs the turn", () => {
    const sim = staged();
    const gun = sim.debugSpawn("artillery", "player", { x: -14, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: 10, z: 0 });
    disarm(target);
    expect(gun.deployed).toBeFalsy();
    sim.debugSelect(gun.id);
    expect(sim.queueShoot(target.id)).toBe(false);
    expect(sim.log[0]).toContain("must deploy");
    expect(sim.queueShootAt({ x: 10, z: 0 })).toBe(false);
    // Holding still for a turn deploys it automatically…
    sim.endTurn();
    settle(sim);
    expect(gun.deployed).toBe(true);
    expect(sim.log.some((l) => l.includes("deploys its outriggers"))).toBe(true);
    // …and deployed it fires (the round is a real order that resolves).
    sim.debugSelect(gun.id);
    expect(sim.queueShootAt({ x: 10, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.includes("fires at the marked spot"))).toBe(true);
    expect(gun.deployed).toBe(true); // it did not move: still deployed

    // Packing up: a move needs the whole turn and undeploys; a half-spent turn is refused.
    sim.debugSelect(gun.id);
    gun.commandPoints = gun.maxCommandPoints - 1;
    if (gun.commandPoints > 0) {
      expect(sim.queueMove({ x: -14, z: -4 })).toBe(false);
      expect(sim.log[0]).toContain("packing up");
    }
    gun.commandPoints = gun.maxCommandPoints;
    expect(sim.queueMove({ x: -14, z: -4 })).toBe(true);
    expect(gun.commandPoints).toBe(0);
    expect(gun.deployed).toBe(false);
    sim.endTurn();
    settle(sim);
    expect(gun.deployed).toBe(false); // moved this resolve, so no auto-deploy
    expect(gun.position.z).toBeLessThan(-1); // it moved (blocked props on Dust Bowl shorten the step)

    // The explicit order takes the whole turn and lands the same flag; it rides a save.
    sim.debugSelect(gun.id);
    expect(sim.queueDeploy()).toBe(true);
    expect(gun.commandPoints).toBe(0);
    expect(sim.queueDeploy()).toBe(false);
    sim.endTurn();
    settle(sim);
    expect(gun.deployed).toBe(true);
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    expect(copy.entity(gun.id)?.deployed).toBe(true);
    // A plain tank never needs any of this.
    const tank = sim.debugSpawn("tank", "player", { x: -14, z: 4 });
    sim.debugSelect(tank.id);
    expect(sim.queueDeploy()).toBe(false);
    expect(sim.queueShootAt({ x: 10, z: 0 })).toBe(true);
  });
});
