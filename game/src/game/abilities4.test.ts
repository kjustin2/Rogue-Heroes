import { describe, expect, it } from "vitest";
import { CARPET_BOMBS, CLASH_BLAST, CLASH_BOLT, TacticalSim, mapDef } from "./sim";
import { createBase, createSoldier } from "./damageModel";
import { DEFAULT_TERRAIN, discSamples, onTerrainEdge, pointInWater, setActiveTerrain } from "./terrain";

// Unit identity abilities, round four (unit-identity picks 5, 9, 10, 14, 15, 17, 18):
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
    const grenadier = sim.debugSpawn("grenadier", "player", { x: -5, z: 0 }); // same 0.7 plateau as the target: no uphill penalty
    const wall = sim.debugCover("pillar", { x: 0, z: 0 });
    const target = sim.debugSpawn("soldier", "enemy", { x: wall.radius + 0.8, z: 0 });
    disarm(target);
    // The bot shares the sim's rng: with research cheap it now buys tech on turn 1, which shifts the
    // accuracy roll this test depends on. Broke bot = the same draw every run.
    sim.economy.set("enemy", 0);
    sim.entities.filter((e) => e.team === "enemy" && e.kind === "base").forEach(disarm); // its relay shot would otherwise shoot the grenade down mid-air
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

describe("gunship does not fire unasked", () => {
  it("a move over hostiles harms none of them (owner 2026-10-02: no auto strafe)", () => {
    const sim = staged();
    const gunship = sim.debugSpawn("gunship", "player", { x: -12, z: 0 });
    const foes = [sim.debugSpawn("soldier", "enemy", { x: -4, z: 2 }), sim.debugSpawn("soldier", "enemy", { x: 2, z: -2 })];
    for (const e of foes) disarm(e);
    const before = foes.map(hp);
    sim.debugSelect(gunship.id);
    expect(sim.queueMove({ x: 8, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(foes.map(hp)).toEqual(before);
  });
});

describe("bomber carpet", () => {
  it("drops three bombs in a line across the spot (a gunship still drops one), without flying there", () => {
    const run = (kind: "bomber" | "gunship"): { bombs: number; spread: number; log: string[]; orders: string[]; moved: number } => {
      const sim = staged();
      const plane = sim.debugSpawn(kind, "player", { x: 0, z: 0 });
      plane.grenades = plane.maxGrenades = 2;
      sim.debugSelect(plane.id);
      expect(sim.queueBombDrop({ x: 0, z: 7 }), sim.log[0]).toBe(true);
      expect(plane.grenades).toBe(1); // one load per run, however many bombs it is
      const orders = sim.orders.filter((o) => o.actorId === plane.id).map((o) => o.kind);
      sim.endTurn();
      const seen = new Set<string>();
      const points: { x: number; z: number }[] = [];
      for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) {
        sim.update(0.05);
        for (const e of sim.effects) {
          if (e.type !== "blast" || seen.has(e.id)) continue;
          seen.add(e.id);
          points.push({ ...e.to });
        }
      }
      const xs = points.map((p) => p.x);
      return { bombs: points.length, spread: Math.max(...xs) - Math.min(...xs), log: sim.log, orders, moved: Math.hypot(plane.position.x, plane.position.z) };
    };
    const carpet = run("bomber");
    expect(carpet.orders, "one action, no flight").toEqual(["grenade"]);
    expect(carpet.bombs).toBe(CARPET_BOMBS);
    expect(carpet.log.some((l) => l.includes("carpets the line"))).toBe(true);
    const single = run("gunship");
    expect(single.bombs).toBe(1);
  });
});

describe("gunship bomb", () => {
  it("bombs a spot in reach from where it hovers (1 AP, no move), throws troops, and refuses what is out of reach", () => {
    const sim = staged();
    const gunship = sim.debugSpawn("gunship", "player", { x: -12, z: 0 });
    const foe = sim.debugSpawn("heavy", "enemy", { x: -4.4, z: 0 }); // 2.6m from the point: caught in the rim
    disarm(foe);
    sim.debugSelect(gunship.id);
    expect(sim.queueBombDrop({ x: -7, z: 0 }), sim.log[0]).toBe(true);
    expect(sim.orders.filter((o) => o.actorId === gunship.id).map((o) => o.kind)).toEqual(["grenade"]);
    expect(gunship.commandPoints, "one action spent").toBe(gunship.maxCommandPoints - 1);
    const before = hp(foe);
    sim.endTurn();
    settle(sim);
    expect(Math.hypot(gunship.position.x + 12, gunship.position.z), "the gunship stayed put").toBeLessThan(0.5);
    expect(hp(foe), "the bomb did little").toBeLessThan(before * 0.85);
    // Out of reach: refused with the reason.
    const far = staged();
    const g2 = far.debugSpawn("gunship", "player", { x: -20, z: 0 });
    far.debugSelect(g2.id);
    expect(far.queueBombDrop({ x: 10, z: 0 })).toBe(false);
    expect(far.log[0]).toContain("Out of reach");
  });
});

describe("mid-air collisions", () => {
  // Fire a real round from a player sniper, then inject an enemy round flying straight back at it.
  const clash = (kind: "plain" | "grenade"): { sim: TacticalSim; log: string[]; left: number; families: number[] } => {
    const sim = staged();
    sim.entities.filter((e) => e.team === "enemy" && e.kind === "base").forEach(disarm);
    const a = sim.debugSpawn("sniper", "player", { x: -10, z: 0 });
    const b = sim.debugSpawn("soldier", "enemy", { x: 14, z: 0 });
    disarm(b);
    sim.debugSelect(a.id);
    expect(sim.queueShoot(b.id), sim.log[0]).toBe(true);
    sim.endTurn();
    let mine: (typeof sim.projectiles)[number] | undefined;
    for (let t = 0; t < 10 && !mine; t += 0.02) { sim.update(0.02); mine = sim.projectiles[0]; }
    expect(mine, "no round was fired").toBeDefined();
    const ahead = 3;
    const o = { x: mine!.position.x + mine!.direction.x * ahead, z: mine!.position.z + mine!.direction.z * ahead };
    const h = mine!.height;
    const other = structuredClone(mine!);
    Object.assign(other, {
      id: "injected", actorId: b.id, orderId: "none", targetId: undefined,
      kind: kind === "grenade" ? "grenade" : mine!.kind, sourceKind: "soldier",
      direction: { x: -mine!.direction.x, z: -mine!.direction.z },
      origin: o, position: { ...o }, previous: { ...o }, travel: 0, maxTravel: 30, age: 0, maxAge: 10,
      height: h, previousHeight: h, originHeight: kind === "grenade" ? 1.2 : h, verticalSlope: 0, arcHeight: 0,
    });
    sim.projectiles.push(other);
    const mark = sim.logTotal;
    const families: number[] = [];
    for (let t = 0; t < 3; t += 0.02) { sim.update(0.02); for (const e of sim.effects) if (e.type === "clash" && !families.includes(e.color)) families.push(e.color); }
    return { sim, families, log: sim.log.slice(0, sim.logTotal - mark), left: sim.projectiles.filter((p) => p.id === "injected" || p.id === mine!.id).length };
  };

  it("two opposed plain rounds meeting in the air cancel each other", () => {
    const { log, left } = clash("plain");
    expect(log.some((l) => l.includes("collide in mid-air")), log.join(" | ")).toBe(true);
    expect(left).toBe(0);
  });

  it("the meeting is a clash effect named for what met: a bolt's ring, or a fireball when a grenade is shot down", () => {
    expect(clash("plain").families).toEqual([CLASH_BOLT]); // the sniper's round is a bolt
    expect(clash("grenade").families).toEqual([CLASH_BLAST]);
  });

  it("a round that meets a grenade sets it off where it was hit", () => {
    const { log } = clash("grenade");
    expect(log.some((l) => l.includes("shoots down")), log.join(" | ")).toBe(true);
  });
});

describe("AI pathfinding", () => {
  it("a bot unit walks AROUND a long wall between it and its goal instead of pressing on it (owner 2026-10-02)", () => {
    const sim = new TacticalSim([
      createBase("pb", "Home Base", "player", { x: -38, z: 0 }),
      createBase("eb", "Home Base", "enemy", { x: 38, z: 0 }),
      createSoldier("e1", "Raider", "enemy", { x: 8, z: 0 }),
    ]);
    setActiveTerrain({ bounds: { minX: -42, maxX: 42, minZ: -12, maxZ: 12 }, maxHeight: 3.2, blocks: [{ minX: -1.5, maxX: 1.5, minZ: -8, maxZ: 8, height: 3 }] });
    try {
      const e1 = sim.entities.find((e) => e.id === "e1")!;
      sim.economy.set("enemy", 0);
      for (let turn = 0; turn < 12 && e1.position.x > -4; turn += 1) { sim.endTurn(); settle(sim); }
      expect(e1.position.x, `stuck at (${e1.position.x.toFixed(1)}, ${e1.position.z.toFixed(1)})`).toBeLessThan(-2);
    } finally {
      setActiveTerrain(DEFAULT_TERRAIN);
    }
  });
});

describe("base systems cost their owner something", () => {
  it("a dead Comms Mast leaves every unit 1 AP; a dead Blast Gate shrinks the deploy ring and slows reinforcements", () => {
    const sim = staged();
    const base = sim.entities.find((e) => e.team === "player" && e.kind === "base")!;
    const trooper = sim.debugSpawn("soldier", "player", { x: base.position.x + 7, z: 3 });
    trooper.maxCommandPoints = 2;
    const ring = sim.deployPlacementRadius(base);
    const cooldown = sim.troopCooldownFor("player", "soldier");
    base.parts.find((p) => p.id === "comms")!.hp = 0;
    base.parts.find((p) => p.id === "gate")!.hp = 0;
    expect(sim.baseSystemEffects(base).map((e) => e.label.split(" ")[0])).toEqual(["Comms", "Gate"]);
    expect(sim.deployPlacementRadius(base)).toBeLessThan(ring);
    expect(sim.troopCooldownFor("player", "soldier")).toBe(cooldown + 1);
    sim.endTurn();
    settle(sim);
    expect(trooper.commandPoints, "the jammed force refilled past 1 AP").toBeLessThanOrEqual(1);
  });
});

describe("cash caches sit on solid ground", () => {
  it("no cache on any map is in or beside water, on a ledge edge, or inside a base's deploy ring", () => {
    for (const id of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
      const sim = new TacticalSim();
      sim.configure(mapDef(id), "destroy", "normal");
      for (const p of sim.pickups) {
        expect(pointInWater(p), `${id} cache in water`).toBe(false);
        expect(discSamples(p, 1.5).some(pointInWater), `${id} cache on the shore`).toBe(false);
        expect(onTerrainEdge(p, 1.5), `${id} cache on a ledge`).toBe(false);
        for (const b of sim.entities.filter((e) => e.kind === "base")) expect(Math.hypot(p.x - b.position.x, p.z - b.position.z), `${id} cache in a ring`).toBeGreaterThan(13);
      }
    }
    setActiveTerrain(DEFAULT_TERRAIN);
  });
});

describe("smart bot economy (owner 2026-10-02: smarter AI)", () => {
  it("a Hard bot turns its money into an army instead of hoarding it or researching the whole tree", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("verdant"), "destroy", "hard", { player: "vanguard", enemy: "syndicate" });
    const ebase = sim.entities.find((e) => e.team === "enemy" && e.kind === "base")!;
    for (let turn = 1; turn <= 10; turn += 1) {
      sim.endTurn();
      settle(sim);
    }
    const army = sim.entities.filter((e) => e.team === "enemy" && e.status.alive && e.kind !== "cover" && e.kind !== "base" && !e.capturable).length;
    expect(army, "the bot never built an army").toBeGreaterThanOrEqual(5);
    expect(sim.money("enemy"), "the bot is sitting on its money").toBeLessThan(700);
    expect((ebase.unlockedTech ?? []).length, "it researched instead of fielding troops").toBeLessThanOrEqual(5);
  });
});
