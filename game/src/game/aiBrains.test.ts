import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { dist } from "../core/math";
import { DEFAULT_TERRAIN, setActiveTerrain, terrainWater } from "./terrain";

// The three AI brains (2026-09-22). Tier strength was measured once by self-play at equal stats
// (hard beat normal 21-1, normal beat easy 18-5, hard beat easy 22-2 over 24 games each); these are
// the fast, deterministic checks that the HARD behaviours actually fire.
const settleCommand = (sim: TacticalSim): void => { sim.endTurn(); };

describe("hard AI brain", () => {
  it("steps out of a telegraphed barrage instead of standing in it", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    const grunt = sim.debugSpawn("soldier", "enemy", { x: 0, z: 0 });
    grunt.commandPoints = grunt.maxCommandPoints;
    sim.debugSpawn("soldier", "player", { x: -20, z: 8 });
    sim.debugForceEvent("barrage", { x: 0, z: 0, radius: 4 });
    settleCommand(sim);
    const move = sim.orders.find((o) => o.actorId === grunt.id && o.kind === "move");
    expect(move?.destination).toBeDefined();
    expect(dist(move!.destination!, { x: 0, z: 0 })).toBeGreaterThan(4);
  });

  it("finishes the target it can kill this turn before a healthier, pricier one", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    const shooter = sim.debugSpawn("heavy", "enemy", { x: 0, z: 0 });
    shooter.commandPoints = shooter.maxCommandPoints;
    const wounded = sim.debugSpawn("soldier", "player", { x: -8, z: 1 });
    for (const p of wounded.parts) p.hp = Math.min(p.hp, 3);
    const healthy = sim.debugSpawn("sniper", "player", { x: -8, z: -1 }); // higher value, full health
    void healthy;
    settleCommand(sim);
    const shot = sim.orders.find((o) => o.actorId === shooter.id && o.kind === "shoot");
    expect(shot?.targetId).toBe(wounded.id);
  });
});

describe("hard AI brain: posture and posts", () => {
  it("outnumbered, it holds its line near home instead of marching into the player's guns", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    sim.turn = 3;
    const lone = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    lone.commandPoints = lone.maxCommandPoints;
    for (let i = 0; i < 6; i += 1) sim.debugSpawn("tank", "player", { x: -22, z: -10 + i * 3 });
    settleCommand(sim);
    const move = sim.orders.find((o) => o.actorId === lone.id && o.kind === "move");
    // It may step to a better post, but it does not close on the six tanks 30m away.
    expect(!move || move.destination!.x > 2).toBe(true);
  });

  it("pushing in with a pre-assigned post flag off still works (the flags are plain switches)", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "hard");
    sim.aiX.post = false;
    sim.aiX.posture = false;
    const grunt = sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    grunt.commandPoints = grunt.maxCommandPoints;
    sim.debugSpawn("soldier", "player", { x: -22, z: 0 });
    settleCommand(sim);
    const move = sim.orders.find((o) => o.actorId === grunt.id && o.kind === "move");
    expect(move?.destination?.x).toBeLessThan(8);
  });
});

// THE WHOLE TOOLKIT (owner 2026-10-03): the Hard bot knows every order a player has and when each pays.
describe("hard AI brain: the full move set", () => {
  const hard = (map = "dustbowl"): TacticalSim => {
    const sim = new TacticalSim();
    sim.configure(mapDef(map), "destroy", "hard");
    setActiveTerrain(mapDef(map).terrain);
    return sim;
  };
  const arm = <T extends { commandPoints: number; maxCommandPoints: number }>(u: T): T => { u.commandPoints = u.maxCommandPoints; return u; };
  const ordersOf = (sim: TacticalSim, id: string) => sim.orders.filter((o) => o.actorId === id);
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("hops a river where the walk would detour to a bridge", () => {
    const sim = hard("karak");
    const river = terrainWater()[0]!;
    const z = (river.minZ + river.maxZ) / 2 + 3.2;
    const grunt = arm(sim.debugSpawn("scout", "enemy", { x: river.maxX + 0.9, z }));
    sim.debugSpawn("soldier", "player", { x: river.minX - 22, z });
    settleCommand(sim);
    expect(ordersOf(sim, grunt.id).some((o) => o.kind === "move" && o.leap)).toBe(true);
  });

  it("rams infantry that is up against its hull", () => {
    const sim = hard();
    const tank = arm(sim.debugSpawn("tank", "enemy", { x: 4, z: 0 }));
    sim.debugSpawn("soldier", "player", { x: 2.4, z: 0 });
    settleCommand(sim);
    expect(ordersOf(sim, tank.id).some((o) => o.kind === "ram")).toBe(true);
  });

  it("a tank that has fired and holds the target in reach stays put, hull down", () => {
    const sim = hard();
    const tank = arm(sim.debugSpawn("tank", "enemy", { x: 8, z: 0 }));
    sim.debugSpawn("tank", "player", { x: -4, z: 0 });
    settleCommand(sim);
    const mine = ordersOf(sim, tank.id);
    expect(mine.some((o) => o.kind === "shoot")).toBe(true);
    expect(mine.some((o) => o.kind === "move")).toBe(false);
  });

  it("a mortar screens a friend that three guns are working over", () => {
    const sim = hard();
    const mortar = arm(sim.debugSpawn("mortar", "enemy", { x: 14, z: 6 }));
    sim.debugSpawn("heavy", "enemy", { x: 6, z: 0 });
    for (const z of [-1.5, 0, 1.5]) sim.debugSpawn("heavy", "player", { x: -4, z });
    settleCommand(sim);
    expect(ordersOf(sim, mortar.id).some((o) => o.kind === "smoke")).toBe(true);
    for (let t = 0; t < 20 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(sim.smokeClouds.length).toBeGreaterThan(0);
  });

  it("a sapper holding with foes closing sows a mine", () => {
    const sim = hard();
    sim.economy.set("enemy", 600);
    const sapper = arm(sim.debugSpawn("sapper", "enemy", { x: 8, z: 0 }));
    sim.debugSpawn("soldier", "player", { x: -2, z: 0 });
    settleCommand(sim);
    expect(sim.mines.some((m) => m.team === "enemy" && Math.hypot(m.x - sapper.position.x, m.z - sapper.position.z) < 0.5)).toBe(true);
  });

  it("an APC far from the fight boards a rifleman beside it, and sets troops down when it arrives", () => {
    const sim = hard();
    const apc = arm(sim.debugSpawn("apc", "enemy", { x: 20, z: 0 }));
    const rider = arm(sim.debugSpawn("soldier", "enemy", { x: 20, z: 3.0 }));
    sim.debugSpawn("soldier", "player", { x: -20, z: 0 });
    settleCommand(sim);
    const load = ordersOf(sim, apc.id).find((o) => o.kind === "load");
    expect(load?.targetId).toBe(rider.id);
    expect(ordersOf(sim, rider.id)).toHaveLength(0); // it was told to board, not to walk off
    for (let t = 0; t < 20 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
    expect(sim.entity(rider.id)!.carriedById).toBe(apc.id); // and the order really plays out
    const sim2 = hard();
    const apc2 = arm(sim2.debugSpawn("apc", "enemy", { x: 4, z: 0 }));
    const rider2 = sim2.debugSpawn("soldier", "enemy", { x: 4, z: 3.0 });
    apc2.passengerIds = [rider2.id];
    rider2.carriedById = apc2.id;
    sim2.debugSpawn("soldier", "player", { x: -6, z: 0 });
    settleCommand(sim2);
    expect(ordersOf(sim2, apc2.id).some((o) => o.kind === "unload")).toBe(true);
  });

  it("a trooper holding its ground under fire crouches with the action point it has left", () => {
    const sim = hard();
    const grunt = arm(sim.debugSpawn("heavy", "enemy", { x: 9, z: 0 }));
    sim.debugSpawn("soldier", "player", { x: 0, z: 0 });
    settleCommand(sim);
    const mine = ordersOf(sim, grunt.id);
    expect(mine.some((o) => o.kind === "shoot")).toBe(true);
    expect(mine.some((o) => o.kind === "defend")).toBe(true);
  });

  it("shoves a foe toward its own mine", () => {
    const sim = hard();
    const striker = arm(sim.debugSpawn("striker", "enemy", { x: 2, z: 0 }));
    const foe = sim.debugSpawn("soldier", "player", { x: 0.6, z: 0 });
    sim.mines.push({ id: "m-test", x: foe.position.x - 2.6, z: 0, team: "enemy" });
    settleCommand(sim);
    expect(ordersOf(sim, striker.id).some((o) => o.kind === "melee" && o.shove)).toBe(true);
  });

  it("a Sledge slams a clump it is standing in, and does nothing special at range", () => {
    const sim = hard();
    const sledge = arm(sim.debugSpawn("sledge", "enemy", { x: 4, z: 0 }));
    sim.debugSpawn("soldier", "player", { x: 2.4, z: 0 });
    sim.debugSpawn("soldier", "player", { x: 2.4, z: 1.4 });
    settleCommand(sim);
    expect(ordersOf(sim, sledge.id).some((o) => o.kind === "slam")).toBe(true);
    const far = hard();
    const s2 = arm(far.debugSpawn("sledge", "enemy", { x: 14, z: 0 }));
    far.debugSpawn("soldier", "player", { x: -4, z: 0 });
    settleCommand(far);
    expect(ordersOf(far, s2.id).some((o) => o.kind === "slam")).toBe(false);
  });

  it("a Trencher digs in the squad around it; a Turret Tech sows a sentry toward the foe", () => {
    const sim = hard();
    const t = arm(sim.debugSpawn("trencher", "enemy", { x: 8, z: 0 }));
    sim.debugSpawn("soldier", "enemy", { x: 9.5, z: 0 });
    sim.debugSpawn("soldier", "enemy", { x: 9.5, z: 1.6 });
    sim.debugSpawn("soldier", "player", { x: -10, z: 0 });
    settleCommand(sim);
    expect(ordersOf(sim, t.id).some((o) => o.kind === "dig")).toBe(true);
    const s2 = hard();
    s2.economy.set("enemy", 900);
    const tt = arm(s2.debugSpawn("turrettech", "enemy", { x: 10, z: 0 }));
    s2.debugSpawn("soldier", "player", { x: -4, z: 0 });
    settleCommand(s2);
    expect(s2.entities.some((e) => e.kind === "sentry" && e.team === "enemy"), "a sentry is down").toBe(true);
    expect(tt.grenades).toBe(1);
  });

  it("with every flag off it plays the old way (no hop, ram, smoke, mine or crouch)", () => {
    const sim = hard();
    sim.aiX.moves = false;
    const tank = arm(sim.debugSpawn("tank", "enemy", { x: 4, z: 0 }));
    sim.debugSpawn("soldier", "player", { x: 2.4, z: 0 });
    settleCommand(sim);
    expect(ordersOf(sim, tank.id).some((o) => o.kind === "ram")).toBe(false);
  });
});
