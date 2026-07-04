import { describe, expect, it } from "vitest";
import { dist } from "../core/math";
import { applyDamage, createBase, createCover, createFlamer, createGrenadier, createHeavy, createMedic, createSapper, createScout, createSniper, createSoldier, createStriker, createTank, createWall } from "./damageModel";
import {
  BASE_INCOME,
  INCOME_BY_LEVEL,
  MAPS,
  POP_CAP,
  START_MONEY_PLAYER,
  TacticalSim,
  generatorEfficiency,
  incomeUpgradeCost,
  troopSpec,
  type Projectile,
} from "./sim";
import { terrainHeightAt } from "./terrain";

describe("tactical simulation loop", () => {
  it("resolves queued target fire back into a new command phase", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 4, z: 0 });
    const reserve = createSoldier("reserve", "Reserve", "enemy", { x: 8, z: 3 });
    applyDamage(enemy, "rifle", 99);
    applyDamage(reserve, "rifle", 99);
    const sim = new TacticalSim([
      createSniper("player", "Vesper", "player", { x: 0, z: 0 }),
      enemy,
      reserve,
    ]);
    sim.entity("player")!.stance = "prone";
    sim.select("player");

    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    expect(sim.orders).toHaveLength(1);

    sim.endTurn();
    advance(sim, 8);

    expect(sim.phase).toBe("command");
    expect(sim.turn).toBe(2);
    expect(enemy.status.alive).toBe(false);
  });

  it("does not let tank rams target friendly units", () => {
    const sim = new TacticalSim([
      createTank("p-tank-1", "Hammer", "player", { x: 0, z: 0 }),
      createSoldier("p-soldier-1", "Rook", "player", { x: 1.6, z: 0 }),
    ]);

    sim.select("p-tank-1");

    expect(sim.queueRam("p-soldier-1")).toBe(false);
    expect(sim.orders).toHaveLength(0);
    expect(sim.log[0]).toBe("Cannot ram friendly units");
  });

  it("cycles the player squad with Tab, wrapping both ways and skipping structures", () => {
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -10, z: 0 }),
      createSoldier("p-a", "Able", "player", { x: 0, z: 0 }),
      createScout("p-b", "Baker", "player", { x: 1.6, z: 0 }),
      createTank("p-c", "Charlie", "player", { x: 3.2, z: 0 }),
      createWall("p-wall", "Barrier", "player", { x: 4.8, z: 0 }),
    ]);

    // Forward cycles in roster order, then wraps from the last unit back to the first
    // (past the wall and base, which are never part of the squad cycle).
    sim.select("p-a");
    sim.cyclePlayer(1);
    expect(sim.selectedId).toBe("p-b");
    sim.cyclePlayer(1);
    expect(sim.selectedId).toBe("p-c");
    sim.cyclePlayer(1);
    expect(sim.selectedId).toBe("p-a");

    // Reverse (Shift+Tab) wraps the other direction: first unit -> last unit.
    sim.cyclePlayer(-1);
    expect(sim.selectedId).toBe("p-c");

    // Selecting a structure then pressing Tab steps onto a real unit, never stalling.
    sim.select("p-wall");
    sim.cyclePlayer(1);
    expect(sim.selectedId).toBe("p-a");
  });

  it("lets a unit spend multiple CP on queued orders and undo individual choices", () => {
    const sim = new TacticalSim([
      createSoldier("p-soldier-1", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("e-soldier-1", "Cutlass", "enemy", { x: 6, z: 0 }),
    ]);

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
    applyDamage(enemy, "legs", 99); // keep the dummy stationary so the player's geometry is deterministic
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
    const sim = new TacticalSim([
      createSoldier("p-soldier-1", "Rook", "player", { x: 0, z: 0 }),
      createTank("e-tank-1", "Breaker", "enemy", { x: 6, z: 0 }),
      createSoldier("e-soldier-1", "Cutlass", "enemy", { x: 4, z: 2 }),
    ]);
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

  it("keeps great-accuracy shots on the exact aimed trajectory", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 7, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([
      createSniper("sniper", "Vesper", "player", { x: 0, z: 0 }),
      enemy,
    ]);
    sim.entity("sniper")!.stance = "crouched";
    const preview = sim.previewShot("sniper", "enemy", "body");
    expect(preview?.accuracy).toBe("great");
    expect(preview?.spreadDegrees).toBe(0);

    sim.select("sniper");
    expect(sim.queueShootPart("enemy", "body")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.projectiles.length > 0, 1.5);

    expect(sim.projectiles[0]?.yawErrorRadians).toBe(0);
    expect(sim.projectiles[0]?.pitchErrorRadians).toBe(0);
  });

  it("makes movement hurt accuracy while crouch improves it and prone is unavailable", () => {
    const standing = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 7, z: 0 }),
    ]);
    const standingPreview = standing.previewShot("player", "enemy", "head");

    const moved = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 7, z: 0 }),
    ]);
    moved.select("player");
    expect(moved.queueMove({ x: 2, z: 0 })).toBe(true);
    const movedPreview = moved.previewShot("player", "enemy", "head");

    const crouched = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 7, z: 0 }),
    ]);
    crouched.entity("player")!.stance = "crouched";
    const crouchedPreview = crouched.previewShot("player", "enemy", "head");

    expect(movedPreview?.spreadDegrees).toBeGreaterThan(standingPreview?.spreadDegrees ?? 0);
    expect(crouchedPreview?.spreadDegrees).toBeLessThan(standingPreview?.spreadDegrees ?? 99);
    expect(movedPreview?.accuracyNotes).toContain("moved before firing");

    const proneQueue = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 7, z: 0 }),
    ]);
    proneQueue.select("player");
    expect(proneQueue.queueDefend("prone")).toBe(false);
    expect(proneQueue.log[0]).toBe("Prone is unavailable in this slice");
  });

  it("does not let non-infantry stance data improve tank accuracy", () => {
    const baseline = new TacticalSim([
      createTank("tank", "Hammer", "player", { x: 0, z: 0 }),
      createTank("enemy", "Breaker", "enemy", { x: 7, z: 0 }),
    ]);
    const baselinePreview = baseline.previewShot("tank", "enemy", "turret");

    const proneTank = createTank("tank", "Hammer", "player", { x: 0, z: 0 });
    proneTank.stance = "prone";
    const stanceLeak = new TacticalSim([
      proneTank,
      createTank("enemy", "Breaker", "enemy", { x: 7, z: 0 }),
    ]);
    const stancePreview = stanceLeak.previewShot("tank", "enemy", "turret");

    expect(stancePreview?.spreadDegrees).toBe(baselinePreview?.spreadDegrees);
    expect(stancePreview?.hitChance).toBe(baselinePreview?.hitChance);
    expect(stancePreview?.accuracyNotes).not.toContain("prone");
  });

  it("lets sway turn a small-part shot into a different part hit on the same target", () => {
    let found: { seed: number; damagedParts: string[] } | undefined;

    for (let seed = 1; seed <= 120 && !found; seed += 1) {
      const target = createSoldier("enemy", "Cutlass", "enemy", { x: 3.4, z: 0 });
      applyDamage(target, "rifle", 99);
      const sim = new TacticalSim([
        createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
        target,
      ]);
      sim.rng.reseed(seed);

      sim.select("player");
      expect(sim.queueMove({ x: 0.2, z: 0 })).toBe(true);
      expect(sim.queueShootPart("enemy", "head")).toBe(true);
      sim.endTurn();
      advance(sim, 6);

      const headHp = target.parts.find((part) => part.id === "head")?.hp;
      const damagedParts = target.parts
        .filter((part) => part.id !== "rifle" && part.hp < part.maxHp)
        .map((part) => part.id);
      if (headHp === 16 && damagedParts.some((partId) => partId !== "head")) found = { seed, damagedParts };
    }

    expect(found).toBeDefined();
    expect(found?.damagedParts).toContain("body");
  });

  it("makes the same inaccurate attack much more reliable at close range", () => {
    const close = new TacticalSim([
      createGrenadier("grenadier", "Briggs", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 1.4, z: 0 }),
    ]);
    const far = new TacticalSim([
      createGrenadier("grenadier", "Briggs", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 9, z: 0 }),
    ]);

    const closePreview = close.previewShot("grenadier", "enemy", "head");
    const farPreview = far.previewShot("grenadier", "enemy", "head");

    expect(closePreview?.accuracy).toBe("terrible");
    expect(farPreview?.accuracy).toBe("terrible");
    expect(closePreview?.hitChance).toBeGreaterThan(farPreview?.hitChance ?? 1);
    expect(closePreview?.hitChance).toBeGreaterThan(0.75);
    expect(farPreview?.hitChance).toBeLessThan(0.35);
  });

  it("lets a highly inaccurate burst stray into a different unit on the line", () => {
    // A heavy gunner sprays a 4-round burst at a distant target; with a bystander near the
    // firing line, the wide spread should sometimes clip the bystander. Search seeds so the
    // test stays robust to the random spread.
    let caught = false;
    for (let seed = 1; seed <= 400 && !caught; seed += 1) {
      const bystander = createSoldier("bystander", "Bystander", "enemy", { x: 6, z: 0.35 });
      const target = createSoldier("target", "Target", "enemy", { x: 13, z: 0 });
      applyDamage(bystander, "rifle", 99);
      applyDamage(bystander, "legs", 99);
      applyDamage(target, "rifle", 99);
      applyDamage(target, "legs", 99);
      bystander.grenades = 0;
      target.grenades = 0;
      const sim = new TacticalSim([
        createHeavy("heavy", "Gunner", "player", { x: 0, z: 0 }),
        bystander,
        target,
      ]);
      sim.rng.reseed(seed);
      sim.select("heavy");
      if (!sim.queueShootPart("target", "body")) continue;
      sim.endTurn();
      advance(sim, 6);
      if (bystander.parts.some((part) => part.id !== "rifle" && part.id !== "legs" && part.hp < part.maxHp)) caught = true;
    }
    expect(caught).toBe(true);
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
    // Replace the enemy's auto AI order with a scripted dash into the wall's line.
    for (let i = sim.orders.length - 1; i >= 0; i -= 1) {
      if (sim.orders[i].actorId === "enemy") sim.orders.splice(i, 1);
    }
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
    expect(sim.orders[0].destination?.x).toBeLessThan(2);
    expect(sim.orders[0].targetId).toBeUndefined();
    expect(sim.log).toContain("Rook's move is blocked by Concrete Wall");

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

  it("limits tank ram reach while allowing nearby tanks to crush cover", () => {
    const far = new TacticalSim([
      createTank("tank", "Hammer", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 8, z: 0 }),
    ]);

    far.select("tank");
    expect(far.queueRam("wall")).toBe(false);
    expect(far.orders).toHaveLength(0);
    expect(far.log[0]).toBe("Concrete Wall is too far to ram");

    const close = new TacticalSim([
      createTank("tank", "Hammer", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 2.5, z: 0 }),
    ]);

    close.select("tank");
    expect(close.queueMoveToCover("wall")).toBe(true);
    expect(close.orders[0].kind).toBe("ram");
    close.endTurn();
    advance(close, 2.4);

    expect(close.entity("wall")?.status.alive).toBe(false);
    expect(close.log).toContain("Hammer crushes through Concrete Wall");
  });

  it("reports far ram targets before confirmation", () => {
    const sim = new TacticalSim([
      createTank("tank", "Hammer", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 9, z: 0 }),
    ]);

    sim.select("tank");
    const status = sim.previewRam("enemy");

    expect(status.ok).toBe(false);
    expect(status.reason).toBe("Cutlass is too far to ram");
    expect(sim.explainRamTarget("enemy")).toBe(false);
    expect(sim.log[0]).toBe("Cutlass is too far to ram");
    expect(sim.orders).toHaveLength(0);
  });

  it("lets a striker make adjacent melee strikes for high close damage", () => {
    const target = createSoldier("enemy", "Cutlass", "enemy", { x: 1.35, z: 0 });
    const sim = new TacticalSim([
      createStriker("striker", "Kade", "player", { x: 0, z: 0 }),
      target,
    ]);

    sim.select("striker");
    expect(sim.previewMelee("enemy").ok).toBe(true);
    expect(sim.queueMelee("enemy")).toBe(true);
    expect(sim.orders[0].kind).toBe("melee");
    sim.endTurn();
    advance(sim, 2.4);

    expect(target.status.alive).toBe(false);
    expect(sim.log.some((line) => line.includes("Kade strikes Cutlass"))).toBe(true);

    const far = new TacticalSim([
      createStriker("striker", "Kade", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 12, z: 0 }),
    ]);
    far.select("striker");
    expect(far.previewMelee("enemy")).toEqual({ ok: false, reason: "Cutlass is too far to strike" });
    expect(far.explainMeleeTarget("enemy")).toBe(false);
    expect(far.log[0]).toBe("Cutlass is too far to strike");
  });

  it("lets rifle infantry bayonet-strike in melee for less than a striker", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 1.1, z: 0 });
    const sim = new TacticalSim([
      createSoldier("rifleman", "Rook", "player", { x: 0, z: 0 }),
      enemy,
    ]);
    sim.select("rifleman");
    expect(sim.previewMelee("enemy").ok).toBe(true);
    const riflemanDmg = sim.previewMeleeDamage("enemy");
    expect(riflemanDmg).toBeGreaterThan(0);

    // The same target struck by a Striker: the specialist hits materially harder.
    const strikerSim = new TacticalSim([
      createStriker("striker", "Kade", "player", { x: 0, z: 0 }),
      createSoldier("enemy2", "Cutlass", "enemy", { x: 1.1, z: 0 }),
    ]);
    strikerSim.select("striker");
    const strikerDmg = strikerSim.previewMeleeDamage("enemy2");
    expect(strikerDmg ?? 0).toBeGreaterThan(riflemanDmg ?? 0);

    // A disarmed rifleman (weapon destroyed) can no longer strike.
    const disarmed = new TacticalSim([
      createSoldier("rook2", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("enemy3", "Cutlass", "enemy", { x: 1.1, z: 0 }),
    ]);
    const rook = disarmed.entity("rook2")!;
    applyDamage(rook, "rifle", 999);
    disarmed.select("rook2");
    expect(disarmed.previewMelee("enemy3").ok).toBe(false);

    // The rifleman's strike actually lands and wounds the target.
    expect(sim.queueMelee("enemy")).toBe(true);
    sim.endTurn();
    advance(sim, 2.4);
    const hp = enemy.parts.reduce((s, p) => s + p.hp, 0);
    const maxHp = enemy.parts.reduce((s, p) => s + p.maxHp, 0);
    expect(hp).toBeLessThan(maxHp);
  });

  it("lets infantry climb low objects but rejects tall walls", () => {
    const low = createCover("crate", "Low Cache", { x: 2, z: 0 }, { coverKind: "ammo", radius: 0.7, height: 0.9 });
    const wall = createCover("wall", "Concrete Wall", { x: 4, z: 0 }, { coverKind: "wall", height: 1.6 });
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      low,
      wall,
    ]);

    sim.select("player");
    expect(sim.queueClimbCover("crate")).toBe(true);
    sim.endTurn();
    advance(sim, 3);

    expect(sim.entity("player")!.elevation).toBeGreaterThan(0.85);

    const blocked = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      wall,
    ]);
    blocked.select("player");
    expect(blocked.queueClimbCover("wall")).toBe(false);
    expect(blocked.log[0]).toBe("Concrete Wall is too tall to climb");
  });

  it("blocks steep cliff movement unless infantry uses a cliff ascent", () => {
    const cliff = createCover("cliff", "Cliff Ascent", { x: 0, z: 4.45 }, { coverKind: "cliff", radius: 1.05, height: 1.85 });
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 3.1 }),
      cliff,
    ]);

    sim.select("player");
    expect(sim.queueMove({ x: 0, z: 5.8 })).toBe(true);
    expect(sim.orders[0].destination?.z).toBeLessThan(5.1);
    expect(sim.log).toContain("Rook must use a cliff ascent");

    const climb = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 3.1 }),
      cliff,
    ]);
    climb.select("player");
    expect(climb.queueClimbCover("cliff")).toBe(true);
    climb.endTurn();
    advance(climb, 2.8);

    expect(climb.entity("player")?.position.z).toBeGreaterThan(4.2);
    expect(climb.entity("player")?.elevation).toBeGreaterThan(0.75);
    expect(climb.log).toContain("Rook climbs the cliff");
  });

  it("rejects tanks trying to use cliff ascents", () => {
    const sim = new TacticalSim([
      createTank("tank", "Hammer", "player", { x: 0, z: 3.2 }),
      createCover("cliff", "Cliff Ascent", { x: 0, z: 4.45 }, { coverKind: "cliff", radius: 1.05, height: 1.85 }),
    ]);

    sim.select("tank");
    expect(sim.queueMoveToCover("cliff")).toBe(false);
    expect(sim.orders).toHaveLength(0);
    expect(sim.log[0]).toBe("Hammer cannot climb the cliff");
  });

  it("queues crouch behind cover and slows the next move", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 2.7, z: 0 }),
    ]);

    sim.select("player");
    expect(sim.queueTakeCover("wall")).toBe(true);
    expect(sim.orders.map((order) => order.kind)).toEqual(["move", "defend"]);

    const normal = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
    ]);
    normal.select("player");
    expect(normal.queueMove({ x: 5, z: 0 })).toBe(true);
    normal.endTurn();
    advance(normal, 1.2);

    const crouched = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
    ]);
    crouched.select("player");
    expect(crouched.queueDefend("crouched")).toBe(true);
    expect(crouched.queueMove({ x: 5, z: 0 })).toBe(true);
    crouched.endTurn();
    advance(crouched, 1.2);

    expect(crouched.entity("player")!.position.x).toBeLessThan(normal.entity("player")!.position.x);
  });

  it("previews melee and ram reach from the queued movement destination", () => {
    const melee = new TacticalSim([
      createStriker("striker", "Kade", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 7.2, z: 0 }),
    ]);
    melee.select("striker");
    expect(melee.queueMove({ x: 3.2, z: 0 })).toBe(true);
    melee.setIntent("melee");

    const meleeRangePreview = melee.selectedActionRange();
    expect(meleeRangePreview?.kind).toBe("melee");
    expect(meleeRangePreview?.position.x).toBeCloseTo(3.2, 1);

    const ram = new TacticalSim([
      createTank("tank", "Hammer", "player", { x: 0, z: 0 }),
      createCover("wall", "Concrete Wall", { x: 7.2, z: 0 }),
    ]);
    ram.select("tank");
    expect(ram.queueMove({ x: 2.2, z: 0 })).toBe(true);
    ram.setIntent("ram");

    const ramRangePreview = ram.selectedActionRange();
    expect(ramRangePreview?.kind).toBe("ram");
    expect(ramRangePreview?.position.x).toBeCloseTo(2.2, 1);
  });

  it("keeps soldiers crouched into the next turn unless they move", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 2.5, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const shooting = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      enemy,
    ]);

    shooting.select("player");
    expect(shooting.queueDefend("crouched")).toBe(true);
    expect(shooting.queueShootPart("enemy", "body")).toBe(true);
    shooting.endTurn();
    advance(shooting, 7);

    expect(shooting.phase).toBe("command");
    expect(shooting.entity("player")?.stance).toBe("crouched");
    expect(shooting.defending.has("player")).toBe(true);

    const moving = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
    ]);
    moving.select("player");
    expect(moving.queueDefend("crouched")).toBe(true);
    expect(moving.queueMove({ x: 2, z: 0 })).toBe(true);
    moving.endTurn();
    advance(moving, 3);

    expect(moving.phase).toBe("command");
    expect(moving.entity("player")?.stance).toBe("standing");
    expect(moving.defending.has("player")).toBe(false);
  });

  it("records turn reports with grouped damage details after resolve", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 2.7, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([
      createSniper("sniper", "Vesper", "player", { x: 0, z: 0 }),
      enemy,
    ]);
    sim.entity("sniper")!.stance = "crouched";

    sim.select("sniper");
    expect(sim.queueShootPart("enemy", "body")).toBe(true);
    sim.endTurn();
    advance(sim, 7);

    expect(sim.currentTurnReport).toBeUndefined();
    expect(sim.turnReports[0]?.phase).toBe("complete");
    expect(sim.turnReports[0]?.entries.some((entry) => entry.targetName === "Cutlass" && entry.amount > 0)).toBe(true);
    expect(sim.turnReports[0]?.notes.some((note) => note.includes("Vesper fires at Cutlass"))).toBe(true);
  });

  it("warns when a friendly unit is in the projectile path", () => {
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      createSoldier("friendly", "Sable", "player", { x: 3, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 6, z: 0 }),
    ]);

    const preview = sim.previewShot("player", "enemy", "body");

    expect(preview?.warningEntityId).toBe("friendly");
    expect(preview?.warningText).toContain("Friendly fire risk");
    expect(preview?.impactEntityId).toBe("friendly");
  });

  it("lets soldiers spend, cancel, and exhaust a limited grenade supply", () => {
    const soldier = createSoldier("player", "Rook", "player", { x: 0, z: 0 });
    const target = createSoldier("target", "Target", "enemy", { x: 6, z: 0 });
    const farTarget = createSoldier("far-target", "Far Target", "enemy", { x: 13, z: 0 });
    const sim = new TacticalSim([soldier, target, farTarget]);

    const preview = sim.previewGrenade("player", "target", "body");
    expect(preview?.projectileKind).toBe("grenade");
    expect(preview?.arcHeight).toBeGreaterThan(1.8);

    sim.select("player");
    expect(sim.queueGrenadePart("target", "body")).toBe(true);
    expect(sim.orders[0]?.kind).toBe("grenade");
    expect(soldier.grenades).toBe(1);
    expect(soldier.commandPoints).toBe(1);

    expect(sim.cancelOrder(sim.orders[0].id)).toBe(true);
    expect(soldier.grenades).toBe(2);
    expect(soldier.commandPoints).toBe(2);

    expect(sim.queueGrenadePart("far-target", "body")).toBe(false);
    expect(sim.log[0]).toContain("outside grenade range");
    expect(soldier.grenades).toBe(2);

    expect(sim.queueGrenadePart("target", "body")).toBe(true);
    expect(sim.queueGrenadePart("target", "body")).toBe(true);
    soldier.commandPoints = 1;
    expect(sim.queueGrenadePart("target", "body")).toBe(false);
    expect(sim.log[0]).toBe("Rook is out of grenades");
  });

  it("launches soldier hand grenades as arcing projectiles", () => {
    const target = createSoldier("target", "Target", "enemy", { x: 6, z: 0 });
    applyDamage(target, "rifle", 99);
    target.grenades = 0;
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      target,
    ]);

    sim.select("player");
    expect(sim.queueGrenadePart("target", "body")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.projectiles.length > 0, 1.5);

    expect(sim.projectiles[0]?.kind).toBe("grenade");
    expect(sim.projectiles[0]?.attackMode).toBe("grenade");
    expect(sim.projectiles[0]?.arcHeight).toBeGreaterThan(1.8);
    expect(sim.projectiles[0]?.speed).toBeLessThan(2.3);
  });

  it("lets soldiers throw grenades at ground locations for area damage", () => {
    const target = createSoldier("target", "Target", "enemy", { x: 6.4, z: 0.35 });
    applyDamage(target, "rifle", 99);
    target.grenades = 0;
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      target,
    ]);

    sim.select("player");
    expect(sim.queueGrenadeAt({ x: 6.2, z: 0 })).toBe(true);
    expect(sim.orders[0]?.kind).toBe("grenade");
    expect(sim.orders[0]?.destination).toEqual({ x: 6.2, z: 0 });
    expect(sim.orders[0]?.targetId).toBeUndefined();
    sim.endTurn();
    advance(sim, 8);

    expect(target.parts.some((part) => part.hp < part.maxHp)).toBe(true);
    expect(sim.log.some((line) => line.includes("grenade"))).toBe(true);
    expect(sim.phase).toBe("command");
  });

  it("requires strikes to start adjacent and applies them to the selected part", () => {
    const target = createSoldier("target", "Target", "enemy", { x: 1.35, z: 0 });
    const farTarget = createSoldier("far-target", "Far Target", "enemy", { x: 5, z: 0 });
    target.grenades = 0;
    farTarget.grenades = 0;
    const sim = new TacticalSim([
      createStriker("striker", "Kade", "player", { x: 0, z: 0 }),
      target,
      farTarget,
    ]);

    sim.select("striker");
    expect(sim.queueMeleePart("target", "head")).toBe(true);
    expect(sim.queueMeleePart("far-target", "body")).toBe(false);
    expect(sim.log[0]).toContain("too far to strike");
    expect(sim.orders).toHaveLength(1);

    sim.endTurn();
    advance(sim, 3);

    expect(target.parts.find((part) => part.id === "head")?.hp).toBeLessThan(14);
    expect(target.parts.find((part) => part.id === "body")?.hp).toBe(46);
  });

  it("gives grenadiers arced projectiles with splash damage around close impacts", () => {
    const target = createSoldier("target", "Target", "enemy", { x: 6, z: 0 });
    const bystander = createSoldier("bystander", "Bystander", "enemy", { x: 6.4, z: 0.85 });
    applyDamage(target, "rifle", 99);
    applyDamage(bystander, "rifle", 99);
    const sim = new TacticalSim([
      createGrenadier("grenadier", "Briggs", "player", { x: 0, z: 0 }),
      target,
      bystander,
    ]);

    const preview = sim.previewShot("grenadier", "target", "body");
    expect(preview?.projectileKind).toBe("grenade");
    expect(preview?.arcHeight).toBeGreaterThan(1.8);

    sim.select("grenadier");
    expect(sim.queueShootPart("target", "body")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.projectiles.length > 0, 1.5);

    expect(sim.projectiles[0]?.kind).toBe("grenade");
    expect(sim.projectiles[0]?.arcHeight).toBeGreaterThan(1.8);

    advance(sim, 8);

    expect(bystander.parts.some((part) => part.id !== "rifle" && part.hp < part.maxHp)).toBe(true);
  });

  it("lets a missed grenade hit ground, roll, and still explode", () => {
    const sim = new TacticalSim([
      createGrenadier("grenadier", "Briggs", "player", { x: 0, z: 2 }),
      createSoldier("target", "Target", "enemy", { x: 0, z: 8 }),
    ]);
    const start = { x: 0, z: 4.55 };
    const startHeight = terrainHeightAt(start) + 0.02;
    const projectile: Projectile = {
      id: "rolling-grenade",
      orderId: "rolling-order",
      actorId: "grenadier",
      targetId: "target",
      targetPartId: "body",
      aim: "center",
      kind: "grenade",
      position: { ...start },
      previous: { ...start },
      origin: { ...start },
      direction: { x: 0, z: 1 },
      verticalSlope: -0.55,
      travel: 0,
      maxTravel: 10,
      aimPoint: { x: 0, z: 9 },
      intendedPoint: { x: 0, z: 8 },
      height: startHeight,
      previousHeight: startHeight,
      originHeight: startHeight,
      speed: 2,
      age: 0,
      maxAge: 5,
      color: 0xffbf69,
      accuracy: "terrible",
      spreadRadians: 0.14,
      yawErrorRadians: 0.14,
      pitchErrorRadians: -0.12,
      arcHeight: 0,
      arcDistance: 1,
      state: "flying",
      rollElapsed: 0,
      rollDuration: 0,
      rollSpeed: 0,
      ignoredEntityIds: [],
    };
    sim.orders.push({
      id: "rolling-order",
      actorId: "grenadier",
      kind: "shoot",
      targetId: "target",
      targetPartId: "body",
      aim: "center",
      elapsed: 0,
      duration: 0.95,
      fired: true,
      done: false,
      projectileId: projectile.id,
    });
    sim.projectiles.push(projectile);
    sim.phase = "resolve";

    sim.update(0.1);

    expect(sim.projectiles[0]?.state).toBe("rolling");
    expect(sim.log).toContain("Briggs's grenade skips and rolls short of Target");

    advance(sim, 1.2);

    expect(sim.projectiles).toHaveLength(0);
    expect(sim.log).toContain("Briggs's grenade rolls and explodes near Target");
  });

  it("keeps a launched projectile alive if the shooter dies before impact", () => {
    const shooter = createSniper("sniper", "Vesper", "player", { x: 0, z: 0 });
    shooter.stance = "prone";
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 7, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([shooter, enemy]);

    sim.select("sniper");
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.projectiles.length > 0, 1.5);
    applyDamage(shooter, "head", 99);

    advance(sim, 5);

    expect(shooter.status.alive).toBe(false);
    expect(enemy.status.alive).toBe(false);
  });

  it("lets a ducked-under head shot continue and hit cover behind the target", () => {
    const shooter = createSniper("sniper", "Vesper", "player", { x: 0, z: 0 });
    shooter.stance = "prone";
    const front = createSoldier("front", "Front", "enemy", { x: 3.4, z: 0 });
    front.stance = "crouched";
    applyDamage(front, "rifle", 99);
    const wall = createCover("wall", "Rear Wall", { x: 9, z: 0 }, { radius: 2.1, height: 3.0 });
    const sim = new TacticalSim([shooter, front, wall]);

    sim.select("sniper");
    expect(sim.queueShootPart("front", "head")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => sim.projectiles.length > 0, 1.5);

    const projectile = sim.projectiles[0];
    wall.position = {
      x: projectile.origin.x + projectile.direction.x * 5.4,
      z: projectile.origin.z + projectile.direction.z * 5.4,
    };

    advance(sim, 5);

    expect(front.parts.find((part) => part.id === "head")?.hp).toBe(16);
    expect(wall.parts[0].hp).toBeLessThan(wall.parts[0].maxHp);
    expect(sim.log).toContain("Front ducks under Vesper's head shot");
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

    const damagedParts = enemyTank.parts.filter((part) => part.hp < part.maxHp).map((part) => part.id);
    expect(damagedParts.length).toBeGreaterThanOrEqual(3);
    expect(damagedParts).toContain("turret");

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
      createSoldier("player", "Rook", "player", { x: -4.5, z: 5.3 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 4.5, z: 5.3 }),
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

  it("records resolve damage without emitting floating damage labels", () => {
    const enemy = createSoldier("enemy", "Cutlass", "enemy", { x: 3.2, z: 0 });
    applyDamage(enemy, "rifle", 99);
    const sim = new TacticalSim([
      createSoldier("player", "Rook", "player", { x: 0, z: 0 }),
      enemy,
    ]);

    sim.select("player");
    expect(sim.queueShootPart("enemy", "head")).toBe(true);
    sim.endTurn();
    advanceUntil(sim, () => Boolean(sim.currentTurnReport?.entries.length), 4);

    expect(sim.currentTurnReport?.entries.some((entry) => entry.targetName === "Cutlass" && entry.amount > 0)).toBe(true);
    expect(sim.effects.some((effect) => "label" in effect)).toBe(false);
  });
});

describe("base economy and troop deployment", () => {
  it("pays base income each round, scaled by reactor health", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);

    expect(sim.money("player")).toBe(START_MONEY_PLAYER);
    sim.endTurn();
    advance(sim, 3);
    expect(sim.turn).toBe(2);
    expect(sim.money("player")).toBe(START_MONEY_PLAYER + BASE_INCOME); // reactor at 100% → full income

    // Partial reactor damage → reduced (but non-zero) income.
    applyDamage(base, "power", 22);
    const efficiency = generatorEfficiency(base);
    expect(efficiency).toBeGreaterThan(0);
    expect(efficiency).toBeLessThan(1);
    const beforePartial = sim.money("player");
    sim.endTurn();
    advance(sim, 3);
    expect(sim.money("player")).toBe(beforePartial + Math.round(BASE_INCOME * efficiency));

    // Destroyed reactor → no income.
    applyDamage(base, "power", 999);
    const beforeDead = sim.money("player");
    sim.endTurn();
    advance(sim, 3);
    expect(base.status.alive).toBe(true);
    expect(sim.money("player")).toBe(beforeDead);
  });

  it("deploys a troop instantly, spending CP and money and applying a cooldown", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.select("p-base-1");

    const cost = troopSpec("soldier").cost;
    const before = sim.money("player");
    expect(sim.queueSpawnTroop("soldier")).toBe(true);
    expect(sim.money("player")).toBe(before - cost);
    expect(base.commandPoints).toBe(0);
    expect(sim.fieldUnitCount("player")).toBe(1);

    const recruit = sim.entities.find((entity) => entity.id.startsWith("p-spawn-"));
    expect(recruit).toBeDefined();
    expect(recruit!.team).toBe("player");
    // A freshly deployed troop holds position until the next turn.
    expect(recruit!.commandPoints).toBe(0);
    expect(dist(recruit!.position, base.position)).toBeLessThan(6);

    // The Recruit type is on cooldown, so a second one is rejected even with CP and money.
    base.commandPoints = 1;
    expect(sim.queueSpawnTroop("soldier")).toBe(false);
    expect(sim.log[0]).toContain("cooldown");
  });

  it("gates troop types behind the tech tree", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.select("p-base-1");

    // The Tank needs the Armor Bay doctrine, which the base has not researched.
    expect(sim.queueSpawnTroop("tank")).toBe(false);
    expect(sim.log[0]).toContain("Armor Bay");
    expect(base.commandPoints).toBe(1); // no CP spent on a rejected deployment
  });

  it("clears a troop cooldown after enough rounds", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.select("p-base-1");

    expect(sim.queueSpawnTroop("soldier")).toBe(true);
    expect(sim.troopCooldown(base, "soldier")).toBe(troopSpec("soldier").cooldown);

    sim.endTurn();
    advance(sim, 3);
    // After the round ticks, the Recruit cooldown has expired and it can deploy again.
    expect(sim.troopCooldown(base, "soldier")).toBe(0);
    expect(sim.spawnFailureReason(base, "soldier")).toBeUndefined();
  });

  it("enforces the hard field cap", () => {
    const entities = [createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 })];
    for (let i = 0; i < POP_CAP; i += 1) {
      entities.push(createSoldier(`p-fill-${i}`, `Fill ${i}`, "player", { x: -8 + i, z: 8 }));
    }
    const sim = new TacticalSim(entities);
    sim.select("p-base-1");

    expect(sim.fieldUnitCount("player")).toBe(POP_CAP);
    expect(sim.queueSpawnTroop("soldier")).toBe(false);
    expect(sim.log[0]).toContain("Field is full");
  });

  it("upgrades income to raise the money paid each round", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.select("p-base-1");

    const cost = incomeUpgradeCost(base)!;
    const before = sim.money("player");
    expect(sim.upgradeBaseIncome()).toBe(true);
    expect(base.incomeLevel).toBe(1);
    expect(base.commandPoints).toBe(0);
    expect(sim.money("player")).toBe(before - cost);

    const beforeIncome = sim.money("player");
    sim.endTurn();
    advance(sim, 3);
    expect(sim.money("player")).toBe(beforeIncome + INCOME_BY_LEVEL[1]);
  });

  it("researches a tech node to unlock new troop types", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.economy.set("player", 600); // enough to research and still field a troop next turn
    sim.select("p-base-1");

    // The Striker needs the Assault doctrine, not yet researched.
    expect(sim.spawnFailureReason(base, "striker")).toContain("Assault");
    expect(sim.researchTech("assault")).toBe(true);
    expect(base.unlockedTech).toContain("assault");
    expect(base.commandPoints).toBe(0);

    // Next turn the base can deploy a now-unlocked Striker.
    sim.endTurn();
    advance(sim, 3);
    sim.select("p-base-1");
    expect(sim.spawnFailureReason(base, "striker")).toBeUndefined();
    expect(sim.queueSpawnTroop("striker")).toBe(true);
    expect(sim.entities.some((entity) => entity.kind === "striker" && entity.team === "player")).toBe(true);
  });

  it("blocks research without prerequisites and respects the tree", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.select("p-base-1");

    // Siege requires Armor, which requires Assault — none researched yet.
    expect(sim.researchFailureReason(base, "siege")).toBeDefined();
    expect(sim.researchTech("siege")).toBe(false);
    // Assault is a root with no prerequisites.
    expect(sim.researchFailureReason(base, "assault")).toBeUndefined();
  });

  it("keeps the home base unarmed", () => {
    const sim = new TacticalSim([
      createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 }),
      createSoldier("foe", "Foe", "enemy", { x: 0, z: 0 }),
    ]);

    expect(sim.entity("p-base-1")!.status.canShoot).toBe(false);
    sim.select("p-base-1");
    expect(sim.queueShoot("foe")).toBe(false);
  });

  it("starts both sides with only a Home Base on a fresh map", () => {
    const sim = new TacticalSim();
    const playerLiving = sim.living("player");
    const enemyLiving = sim.living("enemy");
    expect(playerLiving.length).toBe(1);
    expect(enemyLiving.length).toBe(1);
    expect(playerLiving[0].kind).toBe("base");
    expect(enemyLiving[0].kind).toBe("base");
    expect(sim.fieldUnitCount("player")).toBe(0);
    expect(sim.fieldUnitCount("enemy")).toBe(0);

    // The map provides neutral cover, and the player base is unarmed but can produce.
    expect(sim.entities.some((e) => e.kind === "cover")).toBe(true);
    expect(playerLiving[0].status.canShoot).toBe(false);
    expect(playerLiving[0].status.canProduce).toBe(true);
  });

  it("lets the home base deploy a troop in the full default scenario", () => {
    const sim = new TacticalSim();
    const base = sim.entities.find((entity) => entity.kind === "base" && entity.team === "player")!;
    sim.select(base.id);

    const before = sim.fieldUnitCount("player");
    expect(sim.queueSpawnTroop("soldier")).toBe(true);
    expect(sim.fieldUnitCount("player")).toBe(before + 1);
    expect(sim.entities.some((entity) => entity.id.startsWith("p-spawn-"))).toBe(true);
  });

  it("has the enemy base reinforce its army each turn", () => {
    const enemyBase = createBase("e-base-1", "Relay Base", "enemy", { x: 14, z: 0 });
    enemyBase.unlockedTech = ["assault"];
    const sim = new TacticalSim([
      createBase("p-base-1", "Home Base", "player", { x: -14, z: 0 }),
      enemyBase,
    ]);
    // Enough to deploy a troop but not enough to tempt the base into an upgrade,
    // so the enemy reliably reinforces.
    sim.economy.set("enemy", 250);
    const before = sim.fieldUnitCount("enemy");

    sim.endTurn();
    advance(sim, 3);

    expect(sim.turn).toBe(2);
    expect(enemyBase.status.alive).toBe(true);
    expect(sim.fieldUnitCount("enemy")).toBeGreaterThan(before);
  });
});

describe("game modes, tech tree, and unit variety", () => {
  it("starts every map empty and lays out cover without clumping", () => {
    for (const map of MAPS) {
      const sim = new TacticalSim({ map, mode: "destroy" });
      expect(sim.fieldUnitCount("player")).toBe(0);
      expect(sim.fieldUnitCount("enemy")).toBe(0);
      const cover = sim.entities.filter((e) => e.kind === "cover");
      // The map should place (nearly) all of its authored cover — catches over-constrained
      // scatter that silently under-fills a battlefield.
      const intended =
        (map.signature ?? []).reduce((n, s) => n + (s.mirror && Math.abs(s.x) > 0.3 ? 2 : 1), 0) +
        map.scatter.reduce((n, g) => n + g.count * 2, 0);
      expect(cover.length).toBeGreaterThanOrEqual(Math.floor(intended * 0.9));
      // Objects are never stacked on top of each other (no clumping); deliberate wall
      // lines may sit adjacent, but nothing shares a spot.
      for (let i = 0; i < cover.length; i += 1) {
        for (let j = i + 1; j < cover.length; j += 1) {
          expect(dist(cover[i].position, cover[j].position)).toBeGreaterThan(1.3);
        }
      }
    }
  });

  it("banks control and wins Hold the Hill", () => {
    const sim = new TacticalSim({ mode: "hill" });
    const holder = createSoldier("holder", "Holder", "player", { ...sim.modeState.hill });
    sim.entities.push(holder);
    sim.modeState.playerScore = sim.modeState.target - 1;

    sim.endTurn();
    advance(sim, 4);

    expect(sim.modeState.playerScore).toBeGreaterThanOrEqual(sim.modeState.target);
    expect(sim.phase).toBe("victory");
  });

  it("steals and captures the flag in Capture the Flag", () => {
    const sim = new TacticalSim({ mode: "ctf" });
    const enemyFlag = sim.modeState.flags.find((f) => f.team === "enemy")!;
    const playerFlag = sim.modeState.flags.find((f) => f.team === "player")!;
    const runner = createSoldier("runner", "Runner", "player", { ...enemyFlag.pos });
    sim.entities.push(runner);

    sim.endTurn();
    advance(sim, 4);
    expect(enemyFlag.carrierId).toBe("runner");

    // Carry the stolen flag back to our home flag.
    runner.position = { ...playerFlag.home };
    sim.endTurn();
    advance(sim, 4);
    expect(sim.modeState.playerScore).toBeGreaterThanOrEqual(1);
  });

  it("unlocks armor down the tech tree and deploys a tank", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    base.unlockedTech = ["assault", "armor"]; // armor requires assault
    base.commandPoints = 1;
    sim.economy.set("player", 999);
    sim.select("p-base-1");

    expect(sim.spawnFailureReason(base, "tank")).toBeUndefined();
    expect(sim.queueSpawnTroop("tank")).toBe(true);
    expect(sim.entities.some((e) => e.kind === "tank" && e.team === "player")).toBe(true);
  });

  it("heals nearby infantry with a medic aura each round", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const medic = createMedic("medic", "Medic", "player", { x: 0, z: 0 });
    const wounded = createSoldier("wounded", "Wounded", "player", { x: 1.2, z: 0 });
    applyDamage(wounded, "body", 20);
    const before = wounded.parts.find((p) => p.id === "body")!.hp;
    const sim = new TacticalSim([base, medic, wounded]);

    sim.endTurn();
    advance(sim, 3);

    const after = wounded.parts.find((p) => p.id === "body")!.hp;
    expect(after).toBeGreaterThan(before);
  });
});

describe("defenses, difficulty, and base upgrades", () => {
  it("upgrades the base to two command points per turn", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.economy.set("player", 800);
    sim.select("p-base-1");

    expect(base.maxCommandPoints).toBe(1);
    expect(sim.upgradeBaseCommand()).toBe(true);
    expect(base.maxCommandPoints).toBe(2);
    expect(base.commandPoints).toBe(0); // spent its CP on the upgrade

    // Next turn it refills to two command points.
    sim.endTurn();
    advance(sim, 3);
    sim.select("p-base-1");
    expect(base.commandPoints).toBe(2);
    // A second upgrade is rejected.
    expect(sim.upgradeBaseCommand()).toBe(false);
  });

  it("builds a defensive turret near the base but rejects far or overlapping spots", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: -5 });
    const sim = new TacticalSim([base]);
    sim.economy.set("player", 1500);
    sim.select("p-base-1");

    sim.setPendingBuild("turret");
    // Too far from the base.
    expect(sim.queueBuildStructure({ x: 14, z: 5 })).toBe(false);
    expect(sim.log[0]).toContain("closer to the base");

    expect(sim.queueBuildStructure({ x: -10.5, z: -5 })).toBe(true);
    const turret = sim.entities.find((e) => e.kind === "turret" && e.team === "player");
    expect(turret).toBeDefined();
    expect(turret!.status.canShoot).toBe(true);
    expect(turret!.status.canMove).toBe(false);
    expect(base.commandPoints).toBe(0);

    // A wall can't be dropped on top of the turret we just built.
    base.commandPoints = 1;
    sim.setPendingBuild("wall");
    expect(sim.queueBuildStructure({ x: -10.5, z: -5 })).toBe(false);
    expect(sim.log[0]).toContain("blocked");
  });

  it("lets a tank fire an explosive shell at a ground spot", () => {
    const sim = new TacticalSim([
      createTank("p-tank-1", "Hammer", "player", { x: 0, z: 0 }),
    ]);
    sim.select("p-tank-1");
    expect(sim.queueShootAt({ x: 8, z: 0 })).toBe(true);
    const order = sim.orders[0];
    expect(order.kind).toBe("shoot");
    expect(order.targetId).toBeUndefined();
    expect(order.destination).toEqual({ x: 8, z: 0 });
    expect(sim.entity("p-tank-1")?.commandPoints).toBe(1);
  });

  it("does not let infantry fire at the ground", () => {
    const sim = new TacticalSim([
      createSoldier("p-soldier-1", "Rook", "player", { x: 0, z: 0 }),
    ]);
    sim.select("p-soldier-1");
    expect(sim.selectedCanGroundTarget()).toBe(false);
    expect(sim.queueShootAt({ x: 6, z: 0 })).toBe(false);
  });

  it("gives enemy units more health on harder difficulty", () => {
    const bodyHpForDifficulty = (difficulty: "normal" | "hard"): number => {
      const sim = new TacticalSim();
      sim.configure(MAPS[0], "destroy", difficulty);
      const enemyBase = sim.entities.find((e) => e.kind === "base" && e.team === "enemy")!;
      sim.economy.set("enemy", 160); // afford a Recruit, not a research/upgrade
      enemyBase.commandPoints = 1;
      sim.endTurn();
      advance(sim, 3);
      const spawn = sim.entities.find((e) => e.team === "enemy" && e.id.startsWith("e-spawn-"));
      return spawn?.parts.find((p) => p.id === "body")?.maxHp ?? 0;
    };
    const normalHp = bodyHpForDifficulty("normal");
    const hardHp = bodyHpForDifficulty("hard");
    expect(normalHp).toBeGreaterThan(0);
    expect(hardHp).toBeGreaterThan(normalHp);
  });

  it("provides a move-range circle when Move is armed", () => {
    const sim = new TacticalSim([
      createSoldier("p-soldier-1", "Rook", "player", { x: 0, z: 0 }),
    ]);
    sim.select("p-soldier-1");
    sim.setIntent("move");
    const range = sim.selectedActionRange();
    expect(range?.kind).toBe("move");
    expect(range?.radius).toBeGreaterThan(0);
  });

  it("saves and restores a battle", () => {
    const sim = new TacticalSim();
    sim.configure(MAPS[1], "hill", "hard");
    sim.economy.set("player", 999);
    sim.select(sim.entities.find((e) => e.kind === "base" && e.team === "player")!.id);
    sim.queueSpawnTroop("soldier");
    const saved = sim.serialize();

    const restored = new TacticalSim();
    expect(restored.restore(saved)).toBe(true);
    expect(restored.mapDef.id).toBe(MAPS[1].id);
    expect(restored.mode).toBe("hill");
    expect(restored.difficulty).toBe("hard");
    expect(restored.fieldUnitCount("player")).toBe(1);
  });

  it("preserves which volatile covers already detonated across save/load", () => {
    // Regression: detonated was dropped on serialize, so a destroyed-but-present volatile cover
    // caught in a later blast would explode a second time after loading.
    const sim = new TacticalSim();
    sim.configure(MAPS[0], "destroy", "normal");
    sim.detonated.add("cover-7");
    const restored = new TacticalSim();
    expect(restored.restore(sim.serialize())).toBe(true);
    expect(restored.detonated.has("cover-7")).toBe(true);
  });
});

describe("tactical enemy AI", () => {
  it("concentrates enemy fire on the highest-value target (focus fire) on normal", () => {
    const medic = createMedic("p-medic", "Medic", "player", { x: 0, z: 0 });
    const grunt = createSoldier("p-grunt", "Grunt", "player", { x: 0, z: 2 });
    const a = createSoldier("e-a", "A", "enemy", { x: 6, z: 0 });
    const b = createSoldier("e-b", "B", "enemy", { x: 6, z: 2 });
    a.grenades = 0;
    b.grenades = 0; // keep both on the rifle so we test target choice, not the grenade roll
    const sim = new TacticalSim([medic, grunt, a, b]);

    sim.endTurn();
    const shots = sim.orders.filter((o) => o.kind === "shoot" && (o.actorId === "e-a" || o.actorId === "e-b"));
    expect(shots).toHaveLength(2);
    // Both shooters pile onto the medic (value 8) rather than each taking its own nearest grunt.
    expect(new Set(shots.map((o) => o.targetId))).toEqual(new Set(["p-medic"]));
  });

  it("greedy (easy) enemies each shoot their own nearest target instead of focusing", () => {
    const medic = createMedic("p-medic", "Medic", "player", { x: 0, z: 0 });
    const grunt = createSoldier("p-grunt", "Grunt", "player", { x: 0, z: 2 });
    const a = createSoldier("e-a", "A", "enemy", { x: 6, z: 0 }); // nearest = medic
    const b = createSoldier("e-b", "B", "enemy", { x: 6, z: 2 }); // nearest = grunt
    a.grenades = 0;
    b.grenades = 0;
    const sim = new TacticalSim([medic, grunt, a, b]);
    sim.difficulty = "easy";

    sim.endTurn();
    const shots = sim.orders.filter((o) => o.kind === "shoot" && (o.actorId === "e-a" || o.actorId === "e-b"));
    expect(shots).toHaveLength(2);
    expect(new Set(shots.map((o) => o.targetId)).size).toBe(2); // split fire, not focused
  });

  it("retreats a crippled enemy toward its base instead of feeding it into fire", () => {
    const enemyBase = createBase("e-base", "Relay", "enemy", { x: 14, z: 0 });
    const cripple = createSoldier("e-cripple", "Limp", "enemy", { x: 4, z: 0 });
    applyDamage(cripple, "rifle", 99); // weapon destroyed → cannot shoot
    cripple.grenades = 0;
    const sim = new TacticalSim([
      createSoldier("p", "Rook", "player", { x: 0, z: 0 }),
      enemyBase,
      cripple,
    ]);
    sim.economy.set("enemy", 0); // base has nothing to spend, so only the cripple acts

    sim.endTurn();
    const move = sim.orders.find((o) => o.actorId === "e-cripple" && o.kind === "move");
    expect(move).toBeDefined();
    // The player threat is at x=0; the base is at x=14. A crippled unit falls back (+x), not forward.
    expect(move!.destination!.x).toBeGreaterThan(4);
  });

  it("smart economy answers massed infantry with splash; greedy just buys the priciest unit", () => {
    const spawnedKind = (difficulty: "normal" | "easy") => {
      const enemyBase = createBase("e-base", "Relay", "enemy", { x: 14, z: 0 });
      enemyBase.unlockedTech = ["assault", "ordnance", "armor"]; // grenadier and tank both available
      const sim = new TacticalSim([
        enemyBase,
        createSoldier("p1", "A", "player", { x: 0, z: 0 }),
        createSoldier("p2", "B", "player", { x: 1.4, z: 0 }),
        createSoldier("p3", "C", "player", { x: 2.8, z: 0 }),
      ]);
      sim.difficulty = difficulty;
      sim.economy.set("enemy", 400); // affords a tank (400), grenadier (250), etc.
      sim.endTurn();
      return sim.entities.find((e) => e.team === "enemy" && e.id.startsWith("e-spawn-"))?.kind;
    };
    expect(spawnedKind("normal")).toBe("grenadier"); // splash to counter 3 infantry
    expect(spawnedKind("easy")).toBe("tank"); // greedy = strongest affordable
  });

  it("airstrike support power: pays, cools down, flies in, and damages the line", () => {
    const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
    const enemyBase = createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 8 });
    const victim = createSoldier("e-victim", "Victim", "enemy", { x: 4, z: 0 });
    const sim = new TacticalSim([base, enemyBase, victim]);
    sim.economy.set("player", 1000);
    base.commandPoints = 1;
    sim.select("p-base-1");
    sim.setPendingSupport("airstrike");
    expect(sim.queueSupportAt({ x: 4, z: 0 })).toBe(true);
    expect(sim.money("player")).toBe(1000 - 320);
    expect(sim.supportCooldown(base, "airstrike")).toBe(3);
    // On cooldown + no CP: a second call is rejected.
    sim.setPendingSupport("airstrike");
    expect(sim.queueSupportAt({ x: 4, z: 0 })).toBe(false);

    const hpBefore = victim.parts.reduce((sum, p) => sum + p.hp, 0);
    sim.endTurn();
    let sawJet = false;
    for (let i = 0; i < 200 && sim.phase === "resolve"; i += 1) {
      sim.update(0.05);
      if (sim.effects.some((e) => e.type === "jet")) sawJet = true;
    }
    expect(sawJet).toBe(true);
    expect(victim.parts.reduce((sum, p) => sum + p.hp, 0)).toBeLessThan(hpBefore);
    expect(sim.phase).toBe("command");
  });

  it("locks cluster and laser support behind their doctrines", () => {
    const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
    const sim = new TacticalSim([base, createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 })]);
    sim.economy.set("player", 5000);
    base.commandPoints = 1;
    expect(sim.supportFailureReason(base, "cluster")).toMatch(/Ordnance/i);
    expect(sim.supportFailureReason(base, "laser")).toMatch(/Siege/i);
    base.unlockedTech = ["assault", "ordnance", "armor", "siege"];
    expect(sim.supportFailureReason(base, "cluster")).toBeUndefined();
    expect(sim.supportFailureReason(base, "laser")).toBeUndefined();
  });

  it("last stand: no enemy base, waves spawn, and wiping a wave is not victory", () => {
    const sim = new TacticalSim({ mode: "survival" });
    expect(sim.entities.some((e) => e.kind === "base" && e.team === "enemy")).toBe(false);
    sim.endTurn(); // wave 1 crests before the enemy acts
    expect(sim.entities.filter((e) => e.team === "enemy").length).toBeGreaterThan(0);
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(sim.phase).toBe("command"); // still fighting — no false victory between waves
  });

  it("domination: holding a sector uncontested banks score", () => {
    const sim = new TacticalSim({ mode: "domination" });
    expect(sim.modeState.hills?.length).toBe(3);
    sim.debugSpawn("soldier", "player", sim.modeState.hills![1]); // the player-side sector
    sim.endTurn();
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(sim.modeState.playerScore).toBeGreaterThan(0);
  });

  it("flamer shots leave burning ground that expires after two turns", () => {
    const flamer = createFlamer("p-fl", "Torch", "player", { x: 0, z: 0 });
    const victim = createSoldier("e-v", "Victim", "enemy", { x: 5, z: 0 });
    applyDamage(victim, "rifle", 999); // keep it from shooting back cleanly
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -14, z: 0 }),
      createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 }),
      flamer,
      victim,
    ]);
    sim.select("p-fl");
    expect(sim.queueShootPart("e-v", "body")).toBe(true);
    sim.endTurn();
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(sim.burnZones.length).toBeGreaterThan(0);
    const zonesAfterFirst = sim.burnZones.length;
    sim.endTurn();
    guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    sim.endTurn();
    guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    // The original zones burned down (new ones may exist only if the flamer fired again —
    // it can't, it has no orders queued by the player).
    expect(sim.burnZones.length).toBeLessThan(zonesAfterFirst + 1);
  });

  it("sapper demolition rounds hit cover far harder than a rifleman", () => {
    const sapper = createSapper("p-sap", "Breaker", "player", { x: 0, z: 0 });
    const rifleman = createSoldier("p-sol", "Rifleman", "player", { x: 0, z: 2 });
    const wall = createCover("wall-1", "Concrete Wall", { x: 4, z: 1 });
    const sim = new TacticalSim([sapper, rifleman, wall, createSoldier("e-x", "Foe", "enemy", { x: 14, z: 0 })]);
    const sapPreview = sim.previewShot("p-sap", "wall-1", wall.parts[0].id);
    const solPreview = sim.previewShot("p-sol", "wall-1", wall.parts[0].id);
    expect(sapPreview && solPreview).toBeTruthy();
    expect(sapPreview!.amount).toBeGreaterThan(solPreview!.amount * 2);
  });

  it("a hostile stepping on a mine detonates it", () => {
    const sapper = createSapper("p-sap", "Breaker", "player", { x: 4, z: 0 });
    const runner = createSoldier("e-run", "Runner", "enemy", { x: 8, z: 0 });
    applyDamage(runner, "rifle", 999); // disarmed: it charges the objective
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -14, z: 0 }),
      sapper,
      runner,
    ]);
    sim.economy.set("player", 500);
    sim.select("p-sap");
    expect(sim.queueMine()).toBe(true);
    expect(sim.mines.length).toBe(1);
    // Walk the sapper off the mine so it doesn't shield it.
    sim.queueMove({ x: 4, z: 4 });
    const hpBefore = runner.parts.reduce((sum, p) => sum + p.hp, 0);
    sim.endTurn();
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(sim.mines.length).toBe(0);
    expect(runner.parts.reduce((sum, p) => sum + p.hp, 0)).toBeLessThan(hpBefore);
  });

  it("a lone unit beside a neutral depot captures it and it pays income", () => {
    const depot = createCover("dep-1", "Supply Depot", { x: 3, z: 0 }, { coverKind: "depot" });
    depot.capturable = true;
    const grunt = createSoldier("p-g", "Grunt", "player", { x: 1.8, z: 0 });
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -14, z: 0 }),
      createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 }),
      grunt,
      depot,
    ]);
    sim.endTurn();
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(depot.team).toBe("player");

    const before = sim.money("player");
    sim.endTurn();
    guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(sim.money("player") - before).toBeGreaterThanOrEqual(25); // base income + depot cut
  });

  it("queueCapture sends a distant unit to seize a neutral depot, then holds it for free", () => {
    const depot = createCover("dep-1", "Supply Depot", { x: 4, z: 0 }, { coverKind: "depot" });
    depot.capturable = true;
    const grabber = createSoldier("p-grab", "Vega", "player", { x: 0, z: 0 });
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -14, z: 0 }),
      createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 }),
      grabber,
      depot,
    ]);
    sim.select("p-grab");
    expect(sim.captureFailureReason(grabber, depot)).toBeUndefined();
    expect(sim.captureInReach(grabber, depot)).toBe(false); // too far to hold yet
    expect(sim.queueCapture("dep-1")).toBe(true); // queues a move toward it
    expect(sim.orders.some((o) => o.actorId === "p-grab" && o.kind === "move")).toBe(true);
    sim.endTurn();
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(depot.team).toBe("player");
    // Now yours: capturing again is rejected as redundant, not re-run.
    expect(sim.queueCapture("dep-1")).toBe(false);

    // A unit already beside a still-neutral depot holds it without spending a command point.
    const held = createCover("dep-2", "Supply Depot", { x: 1.4, z: 0 }, { coverKind: "depot" });
    held.capturable = true;
    const near = new TacticalSim([
      createBase("p-base-2", "HQ", "player", { x: -14, z: 0 }),
      createBase("e-base-2", "Enemy HQ", "enemy", { x: 14, z: 0 }),
      createSoldier("p-hold", "Rhee", "player", { x: 0, z: 0 }),
      held,
    ]);
    near.select("p-hold");
    const holder = near.entity("p-hold")!;
    const cp = holder.commandPoints;
    expect(near.captureInReach(holder, held)).toBe(true);
    expect(near.queueCapture("dep-2")).toBe(true);
    expect(holder.commandPoints).toBe(cp); // holding is passive — no CP spent
  });

  it("a killed vehicle leaves a wreck that pays salvage to an adjacent unit", () => {
    const shooter = createSoldier("p-s", "Shooter", "player", { x: 0.5, z: 0 });
    const tank = createTank("e-tank", "Doomed", "enemy", { x: 2, z: 0 });
    const sim = new TacticalSim([
      createBase("p-base-1", "HQ", "player", { x: -14, z: 0 }),
      createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 0 }),
      shooter,
      tank,
    ]);
    sim.debugDamage("e-tank", "hull", 9999, "p-s");
    expect(tank.status.alive).toBe(false);
    const wreck = sim.entities.find((e) => e.coverKind === "wreck");
    expect(wreck).toBeDefined();
    expect(sim.salvage.get(wreck!.id)).toBe(60);

    // The shooter stands beside the wreck; ending the turn strips one salvage tick.
    sim.endTurn();
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) sim.update(0.05);
    expect(sim.phase).toBe("command");
    expect(sim.salvage.get(wreck!.id)).toBe(30);
  });

  it("overwatch: a watcher snaps a reaction shot at the first hostile that moves in range", () => {
    const watcher = createSoldier("p-watch", "Watcher", "player", { x: 0, z: 0 });
    const runner = createSoldier("e-run", "Runner", "enemy", { x: 9, z: 0 });
    applyDamage(runner, "rifle", 999); // disarmed: it will charge instead of shooting
    const sim = new TacticalSim([watcher, runner]);
    sim.select("p-watch");
    expect(sim.queueOverwatch()).toBe(true);
    expect(watcher.commandPoints).toBe(watcher.maxCommandPoints - 1);
    expect(sim.overwatching.get("p-watch")).toBe(1);
    // Double-set is rejected.
    expect(sim.queueOverwatch()).toBe(false);

    sim.endTurn();
    let reaction = false;
    for (let i = 0; i < 400 && sim.phase === "resolve"; i += 1) {
      sim.update(0.05);
      if (sim.projectiles.some((p) => p.actorId === "p-watch")) reaction = true;
    }
    expect(reaction).toBe(true);
    expect(sim.overwatching.size).toBe(0); // consumed (or expired) with the resolve
  });

  it("directional overwatch only fires on hostiles inside the watched arc", () => {
    // Watcher watches toward +Z; a disarmed hostile charges in from -X (behind the arc).
    const watcher = createSoldier("p-watch", "Watcher", "player", { x: 0, z: 0 });
    const flanker = createSoldier("e-run", "Flanker", "enemy", { x: -9, z: 0 });
    applyDamage(flanker, "rifle", 999); // disarmed → it charges (moves) instead of shooting
    const sim = new TacticalSim([watcher, flanker]);
    sim.select("p-watch");
    expect(sim.queueOverwatchToward({ x: 0, z: 10 })).toBe(true); // watch +Z, away from the flanker
    sim.endTurn();
    let firedOutside = false;
    let guard = 0;
    while (sim.phase === "resolve" && guard++ < 400) {
      sim.update(0.05);
      if (sim.projectiles.some((p) => p.actorId === "p-watch")) firedOutside = true;
    }
    expect(firedOutside).toBe(false); // the flanker approached from outside the watch cone

    // Same charge, but the watcher watches toward the enemy (-X): the reaction shot triggers.
    const watcher2 = createSoldier("p-watch2", "Watcher", "player", { x: 0, z: 0 });
    const charger = createSoldier("e-run2", "Charger", "enemy", { x: -9, z: 0 });
    applyDamage(charger, "rifle", 999);
    const sim2 = new TacticalSim([watcher2, charger]);
    sim2.select("p-watch2");
    expect(sim2.queueOverwatchToward({ x: -10, z: 0 })).toBe(true); // watch -X, toward the charger
    sim2.endTurn();
    let firedInside = false;
    guard = 0;
    while (sim2.phase === "resolve" && guard++ < 400) {
      sim2.update(0.05);
      if (sim2.projectiles.some((p) => p.actorId === "p-watch2")) firedInside = true;
    }
    expect(firedInside).toBe(true);
  });

  it("a felled pillar topples away from the attacker and crushes what it lands on", () => {
    const shooter = createSoldier("p-shooter", "Shooter", "player", { x: 0, z: 0 });
    const pillar = createCover("pillar-1", "Support Pillar", { x: 3, z: 0 }, { coverKind: "pillar" });
    const bystander = createSoldier("e-bystander", "Bystander", "enemy", { x: 5.2, z: 0 });
    const sim = new TacticalSim([shooter, pillar, bystander]);
    const hpBefore = bystander.parts.reduce((sum, p) => sum + p.hp, 0);
    // Kill the pillar with the shooter as the damage source: it falls away (+x) onto the bystander.
    sim.debugDamage(pillar.id, pillar.parts[0].id, 9999, shooter.id);
    expect(pillar.status.alive).toBe(false);
    expect(sim.toppled.has("pillar-1")).toBe(true);
    expect(sim.effects.some((e) => e.type === "topple")).toBe(true);
    expect(bystander.parts.reduce((sum, p) => sum + p.hp, 0)).toBeLessThan(hpBefore);
  });

  it("never stalls: a unit that cannot fire still pushes the objective in destroy mode", () => {
    // Regression: destroy mode had no fallback objective, so a unit that couldn't take a
    // shot (here: disarmed, on a no-retreat profile) got no goal at all and stood forever.
    const playerBase = createBase("p-base-1", "Home Base", "player", { x: -14, z: 0 });
    const grunt = createSoldier("e-grunt", "Grunt", "enemy", { x: 10, z: 0 });
    applyDamage(grunt, "rifle", 999); // disarmed: canShoot false
    const foe = createSoldier("p-foe", "Foe", "player", { x: 14, z: 0 }); // close: no advance pull
    const sim = new TacticalSim([playerBase, foe, grunt]);
    sim.difficulty = "easy"; // greedy profile: no retreat, so pre-fix this unit idled
    sim.endTurn();
    const move = sim.orders.find((o) => o.actorId === "e-grunt" && o.kind === "move");
    expect(move?.destination).toBeDefined();
    expect(dist(move!.destination!, playerBase.position)).toBeLessThan(dist(grunt.position, playerBase.position));
  });
});

describe("tech specializations", () => {
  it("makes specialization pairs mutually exclusive", () => {
    const base = createBase("p-base-1", "Home Base", "player", { x: -14, z: 0 });
    const sim = new TacticalSim([base]);
    base.unlockedTech = ["assault"];
    sim.economy.set("player", 9999);
    base.commandPoints = 5;
    sim.select("p-base-1");

    expect(sim.researchTech("breach")).toBe(true);
    expect(sim.researchFailureReason(base, "bulwark")).toMatch(/locked out/i);
    expect(sim.researchTech("bulwark")).toBe(false);
  });

  it("breaching rounds raise infantry damage", () => {
    const previewDamage = (tech: string[]) => {
      const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
      base.unlockedTech = tech;
      const sim = new TacticalSim([
        base,
        createSoldier("p", "Rook", "player", { x: 0, z: 0 }),
        createSoldier("e", "Foe", "enemy", { x: 4, z: 0 }),
      ]);
      return sim.previewShot("p", "e", "body")?.amount ?? 0;
    };
    expect(previewDamage(["assault", "breach"])).toBeGreaterThan(previewDamage([]));
  });

  it("bulwark training deploys infantry with more HP", () => {
    const spawnBodyHp = (tech: string[]) => {
      const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
      base.unlockedTech = tech;
      const sim = new TacticalSim([base]);
      sim.economy.set("player", 9999);
      base.commandPoints = 1;
      sim.select("p-base-1");
      sim.queueSpawnTroop("soldier");
      const spawn = sim.entities.find((e) => e.id.startsWith("p-spawn-"));
      return spawn?.parts.find((p) => p.id === "body")?.maxHp ?? 0;
    };
    expect(spawnBodyHp(["assault", "bulwark"])).toBeGreaterThan(spawnBodyHp(["assault"]));
  });

  it("ghillie doctrine makes your units harder to hit", () => {
    const spread = (enemyTech: string[]): number => {
      const enemyBase = createBase("e-base", "Relay", "enemy", { x: 14, z: 0 });
      enemyBase.unlockedTech = enemyTech;
      const sim = new TacticalSim([
        enemyBase,
        createSoldier("p", "Rook", "player", { x: 0, z: 0 }),
        createSoldier("e", "Foe", "enemy", { x: 8, z: 0 }),
      ]);
      return sim.previewShot("p", "e", "body")?.spreadDegrees ?? 0;
    };
    expect(spread(["recon", "ghillie"])).toBeGreaterThan(spread([]));
  });

  it("thermobarics increases explosive splash damage", () => {
    const splashTotal = (tech: string[]): number => {
      const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
      base.unlockedTech = tech;
      const enemyTank = createTank("et", "Breaker", "enemy", { x: 5, z: 0 });
      const sim = new TacticalSim([base, createTank("pt", "Hammer", "player", { x: 0, z: 0 }), enemyTank]);
      sim.select("pt");
      sim.queueShootPart("et", "turret");
      sim.endTurn();
      advance(sim, 6);
      return enemyTank.parts.reduce((sum, p) => sum + (p.maxHp - p.hp), 0);
    };
    expect(splashTotal(["assault", "ordnance", "thermobarics"])).toBeGreaterThan(splashTotal([]));
  });
});

describe("dynamic map events", () => {
  it("a sandstorm widens accuracy spread", () => {
    const spread = (storm: boolean): number => {
      const sim = new TacticalSim([
        createSoldier("p", "Rook", "player", { x: 0, z: 0 }),
        createSoldier("e", "Foe", "enemy", { x: 8, z: 0 }),
      ]);
      if (storm) sim.debugForceEvent("sandstorm");
      return sim.previewShot("p", "e", "body")?.spreadDegrees ?? 0;
    };
    expect(spread(true)).toBeGreaterThan(spread(false));
  });

  it("an artillery barrage damages units caught in the zone", () => {
    const victim = createSoldier("victim", "Victim", "enemy", { x: 0, z: 0 });
    victim.commandPoints = 0; // hold still, so the shells are unambiguously what hit it
    const sim = new TacticalSim([
      createSoldier("obs", "Observer", "player", { x: 26, z: 10 }),
      victim,
    ]);
    sim.debugForceEvent("barrage", { x: 0, z: 0, radius: 0.5 });
    sim.endTurn();
    advance(sim, 4);
    expect(victim.parts.some((p) => p.hp < p.maxHp)).toBe(true);
  });

  it("an ion storm scrambles units down to one command point", () => {
    const unit = createSoldier("u", "Unit", "player", { x: 0, z: 0 });
    unit.commandPoints = 2;
    const sim = new TacticalSim([unit]);
    expect(unit.commandPoints).toBe(2);
    sim.debugForceEvent("ionstorm");
    expect(unit.commandPoints).toBe(1);
  });

  it("collapsing cover wrecks cover inside the zone", () => {
    const cover = createCover("c1", "Pillar", { x: 0, z: 0 });
    const sim = new TacticalSim([
      createSoldier("p", "Rook", "player", { x: -10, z: 0 }),
      cover,
    ]);
    sim.debugForceEvent("collapse", { x: 0, z: 0, radius: 4 });
    sim.endTurn();
    advance(sim, 4);
    expect(cover.status.alive).toBe(false);
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
