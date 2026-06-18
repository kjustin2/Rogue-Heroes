import { describe, expect, it } from "vitest";
import { applyDamage, createCover, createGrenadier, createSniper, createSoldier, createStriker, createTank } from "./damageModel";
import { TacticalSim, type Projectile } from "./sim";
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

  it("lets a highly inaccurate projectile hit a different unit on the swayed line", () => {
    const bystander = createSoldier("bystander", "Bystander", "enemy", { x: 5, z: 0.2 });
    const target = createSoldier("target", "Target", "enemy", { x: 9, z: 0 });
    applyDamage(bystander, "rifle", 99);
    applyDamage(target, "rifle", 99);
    const sim = new TacticalSim([
      createGrenadier("grenadier", "Briggs", "player", { x: 0, z: 0 }),
      bystander,
      target,
    ]);
    sim.rng.reseed(1);

    sim.select("grenadier");
    expect(sim.queueShootPart("target", "head")).toBe(true);
    sim.endTurn();
    advance(sim, 14);

    expect(target.parts.find((part) => part.id === "head")?.hp).toBe(16);
    expect(bystander.parts.some((part) => part.id !== "rifle" && part.hp < part.maxHp)).toBe(true);
    expect(sim.log).toContain("Bystander is caught in the blast");
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

  it("lets a striker rush into melee for high close damage", () => {
    const target = createSoldier("enemy", "Cutlass", "enemy", { x: 7.4, z: 0 });
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
    expect(sim.log).toContain("Kade strikes Cutlass");

    const far = new TacticalSim([
      createStriker("striker", "Kade", "player", { x: 0, z: 0 }),
      createSoldier("enemy", "Cutlass", "enemy", { x: 12, z: 0 }),
    ]);
    far.select("striker");
    expect(far.previewMelee("enemy")).toEqual({ ok: false, reason: "Cutlass is too far to strike" });
    expect(far.explainMeleeTarget("enemy")).toBe(false);
    expect(far.log[0]).toBe("Cutlass is too far to strike");
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
