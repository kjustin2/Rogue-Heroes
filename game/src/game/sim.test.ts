import { describe, expect, it } from "vitest";
import { applyDamage, createCover, createSoldier, createTank } from "./damageModel";
import { TacticalSim } from "./sim";

describe("tactical simulation loop", () => {
  it("resolves queued target fire back into a new command phase", () => {
    const sim = new TacticalSim();
    for (const entity of sim.entities) {
      if (entity.team === "neutral") entity.position.z = 8;
    }

    sim.select("p-tank-1");
    sim.setAim("mobility");

    expect(sim.queueShoot("e-tank-1")).toBe(true);
    expect(sim.orders).toHaveLength(1);

    sim.endTurn();
    advance(sim, 4);

    const enemyTank = sim.entity("e-tank-1");
    const leftTread = enemyTank?.parts.find((part) => part.id === "left-tread");

    expect(sim.phase).toBe("command");
    expect(sim.turn).toBe(2);
    expect(leftTread?.hp).toBeLessThan(34);
  });

  it("does not let tank rams target friendly units", () => {
    const sim = new TacticalSim();

    sim.select("p-tank-1");

    expect(sim.queueRam("p-soldier-1")).toBe(false);
    expect(sim.orders).toHaveLength(0);
    expect(sim.log[0]).toBe("Cannot ram friendly units");
  });

  it("lets a unit spend multiple CP on queued orders and undo individual choices", () => {
    const sim = new TacticalSim();

    sim.select("p-soldier-1");
    expect(sim.queueShootPart("e-soldier-1", "rifle")).toBe(true);
    expect(sim.orders).toHaveLength(1);
    expect(sim.entity("p-soldier-1")?.commandPoints).toBe(1);

    expect(sim.queueMove({ x: -7, z: -1 })).toBe(true);
    expect(sim.orders.map((order) => order.kind)).toEqual(["shoot", "move"]);
    expect(sim.entity("p-soldier-1")?.commandPoints).toBe(0);

    expect(sim.cancelOrder(sim.orders[0].id)).toBe(true);
    expect(sim.orders.map((order) => order.kind)).toEqual(["move"]);
    expect(sim.entity("p-soldier-1")?.commandPoints).toBe(1);
    expect(sim.log[0]).toBe("Rook order cancelled");
  });

  it("previews a queued follow-up shot from the unit's moved position", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: 0 });
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      enemy,
    ]);

    const initialPreview = sim.previewShot("player", "enemy", "head");
    sim.select("player");
    expect(sim.queueMove({ x: 2, z: 0 })).toBe(true);
    const movedPreview = sim.previewShot("player", "enemy", "head");

    expect(initialPreview).toBeDefined();
    expect(movedPreview).toBeDefined();
    expect(movedPreview!.from.x).toBeGreaterThan(initialPreview!.from.x + 1.7);
  });

  it("executes move then shoot from the moved position", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      enemy,
    ]);

    sim.select("player");
    expect(sim.queueMove({ x: 2, z: 0 })).toBe(true);
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.projectiles.length > 0, 1.5);

    expect(sim.entity("player")?.position.x).toBeGreaterThan(1.9);
    expect(sim.projectiles[0]?.origin.x).toBeGreaterThan(2.2);
    expect(sim.projectiles[0]?.origin.x).toBeLessThan(2.7);
  });

  it("can finish a one-fight victory from normal queued combat", () => {
    const sim = new TacticalSim([
      createTank("player-tank", "Hammer", "player", { x: 0, z: 0 }),
      createSoldier("enemy-scout", "Scout", "enemy", { x: 2, z: 0 }),
    ]);

    sim.select("player-tank");
    sim.setAim("head");

    expect(sim.queueShoot("enemy-scout")).toBe(true);
    sim.endTurn();
    advance(sim, 4);

    expect(sim.phase).toBe("victory");
    expect(sim.log).toContain("Enemy force disabled");
  });

  it("only exposes intact parts that exist on the selected target type", () => {
    const sim = new TacticalSim();
    const enemyTank = sim.entity("e-tank-1");
    const enemySoldier = sim.entity("e-soldier-1");

    expect(enemyTank).toBeDefined();
    expect(enemySoldier).toBeDefined();
    expect(sim.targetableParts(enemyTank!).map((part) => part.id)).toEqual([
      "hull",
      "turret",
      "cannon",
      "left-tread",
      "right-tread",
      "front-plate",
    ]);
    expect(sim.targetableParts(enemySoldier!).map((part) => part.id)).toEqual(["body", "head", "rifle", "legs", "pack"]);

    sim.select("p-soldier-1");
    expect(sim.queueShootPart("e-tank-1", "head")).toBe(false);
    expect(sim.orders).toHaveLength(0);
    expect(sim.log[0]).toBe("Breaker does not have that targetable part");
  });

  it("previews and resolves shots into blocking cover before the intended enemy part", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 3, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: 0 }),
    ]);

    const preview = sim.previewShot("player", "enemy", "head");

    expect(preview?.blockedById).toBe("wall");
    expect(preview?.impactEntityId).toBe("wall");
    expect(preview?.impactPartId).toBe("wall");

    sim.select("player");
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    advance(sim, 4);

    const wall = sim.entity("wall");
    const enemy = sim.entity("enemy");
    expect(wall?.parts[0].hp).toBeLessThan(70);
    expect(enemy?.parts.find((part) => part.id === "head")?.hp).toBe(16);
    expect(sim.log).toContain("Concrete Wall intercepts shot at Cutlass");
  });

  it("uses the selected part to change projectile trajectory through cover", () => {
    const thinCover = createCover("thin-cover", "Thin Cover", { x: 3, z: -0.45 });
    thinCover.radius = 0.05;
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      thinCover,
      createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: 0 }),
    ]);

    const bodyPreview = sim.previewShot("player", "enemy", "body");
    const headPreview = sim.previewShot("player", "enemy", "head");

    expect(bodyPreview?.aimPoint).not.toEqual(headPreview?.aimPoint);
    expect(bodyPreview?.blockedById).toBe("thin-cover");
    expect(headPreview?.blockedById).toBeUndefined();
  });

  it("makes soldier head shots a weak-point damage choice", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 4, z: 0 }),
    ]);

    const headPreview = sim.previewShot("player", "enemy", "head");
    const bodyPreview = sim.previewShot("player", "enemy", "body");

    expect(headPreview?.amount).toBeGreaterThan(bodyPreview?.amount ?? 0);
  });

  it("lets soldiers duck under incoming head shots but not body shots", () => {
    const headSim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 2.8, z: 0 }),
    ]);

    headSim.select("player");
    expect(headSim.queueDefend()).toBe(true);
    headSim.orders.push(enemyShootOrder("enemy-head", "enemy", "player", "head"));
    headSim.phase = "resolve";
    advance(headSim, 2);

    expect(headSim.entity("player")?.parts.find((part) => part.id === "head")?.hp).toBe(16);
    expect(headSim.log).toContain("Rook ducks under Cutlass's head shot");

    const bodySim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 2.8, z: 0 }),
    ]);

    bodySim.select("player");
    expect(bodySim.queueDefend()).toBe(true);
    bodySim.orders.push(enemyShootOrder("enemy-body", "enemy", "player", "body"));
    bodySim.phase = "resolve";
    advance(bodySim, 2);

    expect(bodySim.entity("player")?.parts.find((part) => part.id === "body")?.hp).toBeLessThan(46);
  });

  it("launches a visible projectile before applying shot damage", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 2.5, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      enemy,
    ]);

    sim.select("player");
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    advance(sim, 0.66);

    const target = sim.entity("enemy");
    expect(sim.projectiles).toHaveLength(1);
    expect(target?.parts.find((part) => part.id === "head")?.hp).toBe(16);

    advance(sim, 1.2);

    expect(sim.projectiles).toHaveLength(0);
    expect(target?.status.alive).toBe(false);
  });

  it("lets a moving target drag a tracked shot into cover during resolve", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: -2 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 3, z: 0.3 }),
      enemy,
    ]);

    const preview = sim.previewShot("player", "enemy", "head");
    expect(preview?.blockedById).toBeUndefined();

    sim.select("player");
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    sim.orders.push({
      id: "enemy-move",
      actorId: "enemy",
      kind: "move",
      destination: { x: 6, z: 2 },
      aim: "center",
      elapsed: 0,
      duration: 1.15,
      fired: false,
      done: false,
    });

    advance(sim, 4);

    const wall = sim.entity("wall");
    expect(wall?.parts[0].hp).toBeLessThan(70);
    expect(enemy.parts.find((part) => part.id === "head")?.hp).toBe(16);
    expect(sim.log).toContain("Concrete Wall intercepts shot at Cutlass");
  });

  it("limits move distance and treats move-clicking cover as taking cover", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 3, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 8, z: 0 }),
    ]);

    sim.select("player");
    expect(sim.queueMove({ x: 10, z: 0 })).toBe(true);
    expect(sim.orders[0].destination?.x).toBeCloseTo(3.7, 1);
    expect(sim.orders[0].targetId).toBeUndefined();

    const coverSim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 3, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 8, z: 0 }),
    ]);
    coverSim.select("player");
    expect(coverSim.queueMoveToCover("wall")).toBe(true);
    const coverMove = coverSim.orders[0];
    expect(coverMove.kind).toBe("move");
    expect(coverMove.targetId).toBeUndefined();
    expect(coverMove.destination?.x).toBeGreaterThan(0.5);
    expect(coverMove.destination?.x).toBeLessThan(3);
  });

  it("makes tank shells splash nearby parts and crush cover harder than rifle fire", () => {
    const enemyTank = createTank("enemy-tank", "Breaker", "enemy", { x: 4, z: 0 });
    const sim = new TacticalSim([
      createTank("player-tank", "Hammer", "player", { x: 0, z: 0 }),
      enemyTank,
      createCover("wall", "Concrete Wall", { x: 8, z: 0 }),
    ]);

    sim.select("player-tank");
    expect(sim.queueShootPart("enemy-tank", "turret")).toBe(true);
    sim.endTurn();
    advance(sim, 6);

    expect(enemyTank.parts.find((part) => part.id === "turret")?.hp).toBeLessThan(55);
    expect(enemyTank.parts.find((part) => part.id === "cannon")?.hp).toBeLessThan(42);

    const wallSim = new TacticalSim([
      createTank("player-tank", "Hammer", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 4, z: 0 }),
    ]);
    wallSim.select("player-tank");
    const preview = wallSim.previewShot("player-tank", "wall", "wall");
    expect(preview?.amount).toBeGreaterThan(70);
    expect(wallSim.queueShootPart("wall", "wall")).toBe(true);
    wallSim.endTurn();
    advance(wallSim, 6);

    expect(wallSim.entity("wall")?.status.alive).toBe(false);
  });

  it("marks low projectile lines as blocked when they would hit high ground first", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: -2.5, z: 5.3 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 3.2, z: 5.3 }),
    ]);

    const legsPreview = sim.previewShot("player", "enemy", "legs");
    const headPreview = sim.previewShot("player", "enemy", "head");

    expect(legsPreview?.blockedByGround).toBe(true);
    expect(legsPreview?.amount).toBe(0);
    expect(headPreview?.blockedByGround).toBeFalsy();
  });

  it("boosts nearby allied shot damage while a support relay is intact", () => {
    const baseline = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 4, z: 0 }),
    ]);
    const boostedSupport = createSoldier("support", "Sable", "player", { x: 1.4, z: 0 });
    const pack = boostedSupport.parts.find((part) => part.id === "pack");
    if (pack) pack.tags = ["support-aura"];
    const boosted = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      boostedSupport,
      createSoldier("enemy", "Cutlass", "enemy", { x: 4, z: 0 }),
    ]);

    const baselineDamage = baseline.previewShot("player", "enemy", "body")?.amount ?? 0;
    const boostedDamage = boosted.previewShot("player", "enemy", "body")?.amount ?? 0;

    expect(boostedDamage).toBeGreaterThan(baselineDamage);
  });
});

function advance(sim: TacticalSim, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.05) sim.update(0.05);
}

function advanceUntil(sim: TacticalSim, predicate: () => boolean, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds && !predicate(); elapsed += 0.05) sim.update(0.05);
}

function enemyShootOrder(id: string, actorId: string, targetId: string, targetPartId: string) {
  return {
    id,
    actorId,
    kind: "shoot" as const,
    targetId,
    targetPartId,
    aim: targetPartId === "head" ? "head" as const : "core" as const,
    elapsed: 0,
    duration: 0.95,
    fired: false,
    done: false,
  };
}
