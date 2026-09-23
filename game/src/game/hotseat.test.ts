import { describe, expect, it } from "vitest";
import { createBase, createSoldier } from "./damageModel";
import { START_MONEY_PLAYER, TacticalSim, mapDef } from "./sim";

const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const hotseat = (map = "dustbowl"): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef(map), "destroy", "normal", { player: "vanguard", enemy: "bastion" }, true);
  return sim;
};

// LOCAL 2-PLAYER: both seats plan through the same "player" UI via swapSides(); the AI never
// orders, and the resolve always runs with Player 1 as "player".
describe("hotseat", () => {
  it("each human's orders survive the swap, the AI adds none, and the resolve runs unswapped", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal", { player: "vanguard", enemy: "bastion" }, true);
    const p1 = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    const p2 = sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });
    const cash1 = sim.economy.get("player");
    sim.economy.set("enemy", 777);

    sim.select(p1.id);
    expect(sim.queueMove({ x: -4, z: 0 })).toBe(true);

    sim.swapSides(); // Player 2's turn to plan
    expect(sim.sidesSwapped).toBe(true);
    expect(p2.team).toBe("player");
    expect(p1.team).toBe("enemy");
    expect(sim.economy.get("player")).toBe(777);
    expect(sim.factionIdOf("player")).toBe("bastion");
    sim.select(p2.id);
    expect(sim.queueMove({ x: 4, z: 0 })).toBe(true);

    sim.endTurn();
    expect(sim.sidesSwapped).toBe(false);
    expect(p1.team).toBe("player");
    expect(sim.economy.get("player")).toBe(cash1);
    expect(sim.factionIdOf("player")).toBe("vanguard");
    const actors = sim.orders.map((o) => o.actorId).sort();
    expect(actors).toEqual([p1.id, p2.id].sort()); // no AI orders on top
  });

  it("round-trips the hotseat flag through a save", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("verdant"), "hill", "normal", undefined, true);
    const copy = new TacticalSim();
    expect(copy.restore(sim.serialize())).toBe(true);
    expect(copy.hotseat).toBe(true);
  });

  it("both humans start with the same purse (the bot's smaller one is a handicap for the human)", () => {
    const sim = hotseat();
    expect(sim.money("player")).toBe(START_MONEY_PLAYER);
    expect(sim.money("enemy")).toBe(START_MONEY_PLAYER);
    const vsBot = new TacticalSim();
    vsBot.configure(mapDef("dustbowl"), "destroy", "normal");
    expect(vsBot.money("enemy")).toBeLessThan(vsBot.money("player"));
  });

  it("the next seat cannot read the other human's orders off the log, and inherits none of their half-picks", () => {
    const sim = hotseat();
    const opening = sim.log.slice();
    const p1 = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    sim.select(p1.id);
    expect(sim.queueMove({ x: -4, z: 0 })).toBe(true);
    expect(sim.log.some((l) => l.includes(p1.name))).toBe(true);
    sim.setIntent("move");
    sim.setPendingSupport("airstrike");
    sim.swapSides();
    expect(sim.log.some((l) => l.includes(p1.name))).toBe(false);
    expect(sim.log).toEqual(opening); // what both players saw before planning is still there
    expect(sim.intent).toBe("select");
    expect(sim.pendingSupport).toBeUndefined();
    // Player 2's own lines survive until THEY hand the seat back, and the resolve keeps its log.
    const p2 = sim.debugSpawn("soldier", "player", { x: 6, z: 0 });
    sim.select(p2.id);
    expect(sim.queueMove({ x: 4, z: 0 })).toBe(true);
    expect(sim.log.some((l) => l.includes(p2.name))).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.turn).toBe(2);
    const afterResolve = sim.log.slice();
    sim.swapSides(); // turn 2: Player 2 plans first
    expect(sim.log).toEqual(afterResolve); // nothing planned yet, nothing dropped
  });

  it("a restart from Player 2's seat keeps each player's faction", () => {
    const sim = hotseat();
    sim.swapSides();
    expect(sim.factionIdOf("player")).toBe("bastion");
    sim.reset();
    expect(sim.sidesSwapped).toBe(false);
    expect(sim.factionIdOf("player")).toBe("vanguard");
    expect(sim.factionIdOf("enemy")).toBe("bastion");
    expect(sim.money("enemy")).toBe(START_MONEY_PLAYER);
  });

  it("recon reveals the other human's real orders to the seat that flew it, and only to that seat", () => {
    const sim = hotseat();
    const op = sim.debugSpawn("droneop", "enemy", { x: 8, z: 0 }); // Player 2's drone op
    const p1 = sim.debugSpawn("soldier", "player", { x: -8, z: 0 });
    sim.swapSides(); // Player 2 plans and flies the pulse
    sim.debugSelect(op.id);
    expect(sim.queueRecon()).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(sim.turn).toBe(2);
    expect(sim.revealedOrders).toBe(true);
    expect(sim.revealedSeat()).toBe(2);
    // Player 1 plans first (the revealing seat plans second) and cannot see anything revealed.
    expect(sim.enemyIntents()).toEqual([]);
    sim.select(p1.id);
    expect(sim.queueMove({ x: -6, z: 1 })).toBe(true);
    sim.swapSides();
    expect(sim.revealedSeat()).toBe(2);
    const intents = sim.enemyIntents();
    expect(intents.map((i) => i.actorId)).toEqual([p1.id]);
    expect(intents[0].destination).toBeDefined();
    // The reveal is about the other seat, so it never stops Player 1 flying a pulse of their own.
    sim.swapSides();
    const op1 = sim.debugSpawn("droneop", "player", { x: -8, z: 4 });
    sim.debugSelect(op1.id);
    expect(sim.reconFailureReason(op1)).toBeUndefined();
  });

  it("a queued support strike survives a save (money, CP and cooldown were already paid)", () => {
    const base = createBase("p-base-1", "HQ", "player", { x: -14, z: 0 });
    const enemyBase = createBase("e-base-1", "Enemy HQ", "enemy", { x: 14, z: 8 });
    const victim = createSoldier("e-victim", "Victim", "enemy", { x: 4, z: 0 });
    const sim = new TacticalSim([base, enemyBase, victim]);
    sim.economy.set("player", 1000);
    base.commandPoints = 1;
    sim.select("p-base-1");
    sim.setPendingSupport("airstrike");
    expect(sim.queueSupportAt({ x: 4, z: 0 })).toBe(true);
    const copy = new TacticalSim([]);
    expect(copy.restore(sim.serialize())).toBe(true);
    const hpBefore = copy.entity("e-victim")!.parts.reduce((sum, p) => sum + p.hp, 0);
    copy.endTurn();
    settle(copy);
    const after = copy.entity("e-victim")!;
    expect(after.parts.reduce((sum, p) => sum + p.hp, 0)).toBeLessThan(hpBefore);
  });

  it("names the two players in the log instead of 'you' and 'the enemy'", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("verdant"), "hill", "normal", undefined, true);
    sim.debugSpawn("soldier", "enemy", { ...sim.modeState.hill });
    sim.endTurn();
    settle(sim);
    expect(sim.log.some((l) => l.startsWith("Player 2 holds the hill"))).toBe(true);
    expect(sim.log.some((l) => /\b(You|Enemy)\b/.test(l) && l.includes("hill"))).toBe(false);
  });
});
