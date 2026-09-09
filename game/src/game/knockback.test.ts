import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, pointInWater, setActiveTerrain, terrainWater } from "./terrain";
import { dist } from "../core/math";

// NOTE ON STAGING: victims are PLAYER units, hit by friendly-fire splash. An enemy victim gets
// moved by the enemy AI during the same turn, which swamps the thing being measured — the first
// draft of this file "proved" that a grenade throws a tank five metres.
//
// A blast throws what it does not kill, and a body thrown into a channel drowns. Both are easy to
// break silently: knockback moves an entity OUTSIDE the normal movement path, so a "simplified"
// march could walk a unit through a cliff face or off the board, and the drown is the only place in
// the game where terrain kills outright.

const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};

/** A map with authored water, so the drowning case has somewhere to drown. */
const WET = "karak";

const staged = (): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef(WET), "destroy", "normal");
  return sim;
};

/**
 * The grenade order is gated on KIND (soldier / gunship / bomber — a "grenadier" fires a launcher,
 * not a thrown grenade) and debugSpawn hands out an empty pouch, so the thrower is a line soldier
 * with grenades written in. Getting either wrong rejects every order here with
 * "carries no bombs/grenades", which is what the first three drafts of this file did.
 */
const armed = (sim: TacticalSim, at: { x: number; z: number }) => {
  const thrower = sim.debugSpawn("soldier", "player", at);
  thrower.maxGrenades = 3;
  thrower.grenades = 3;
  sim.debugSelect(thrower.id);
  return thrower;
};

describe("blast knockback", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("throws infantry away from the blast, and much further than armour", () => {
    const sim = staged();
    // Equidistant from the blast, so only mass differs.
    const trooper = sim.debugSpawn("soldier", "player", { x: -2, z: 0 });
    const tank = sim.debugSpawn("tank", "player", { x: 2, z: 0 });
    const troopStart = { ...trooper.position };
    const tankStart = { ...tank.position };

    armed(sim, { x: 0, z: 7 });
    expect(sim.queueGrenadeAt({ x: 0, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);

    const troopMoved = dist(trooper.position, troopStart);
    const tankMoved = dist(tank.position, tankStart);
    expect(troopMoved, "a grenade should shove a trooper").toBeGreaterThan(0.2);
    expect(tankMoved, "and barely register against a tank").toBeLessThan(troopMoved / 2);
    // And away from the blast, never toward it.
    expect(Math.abs(trooper.position.x)).toBeGreaterThan(Math.abs(troopStart.x) - 0.001);
  });

  it("never throws anyone outside the arena", () => {
    const sim = staged();
    const bounds = mapDef(WET).terrain.bounds;
    const victim = sim.debugSpawn("soldier", "player", { x: bounds.maxX - 0.5, z: 0 });
    armed(sim, { x: bounds.maxX - 9, z: 0 });
    expect(sim.queueGrenadeAt({ x: bounds.maxX - 2.4, z: 0 })).toBe(true);
    sim.endTurn();
    settle(sim);

    expect(victim.position.x).toBeLessThanOrEqual(bounds.maxX + 0.001);
    expect(victim.position.x).toBeGreaterThanOrEqual(bounds.minX - 0.001);
    expect(victim.position.z).toBeLessThanOrEqual(bounds.maxZ + 0.001);
    expect(victim.position.z).toBeGreaterThanOrEqual(bounds.minZ - 0.001);
  });

  it("drowns a trooper blasted into open water", () => {
    const sim = staged();
    const water = terrainWater();
    expect(water.length, `${WET} should have authored water`).toBeGreaterThan(0);

    // Bridges cross these rects, so the centre is not reliably wet — scan for a z that is.
    const rect = water[0];
    const midX = (rect.minX + rect.maxX) / 2;
    let wetZ: number | undefined;
    for (let i = 1; i < 20 && wetZ === undefined; i += 1) {
      const z = rect.minZ + ((rect.maxZ - rect.minZ) * i) / 20;
      if (pointInWater({ x: midX, z })) wetZ = z;
    }
    expect(wetZ, "no open water found in the first water rect").toBeDefined();

    // Step east out of the channel until dry: that bank is where the victim stands.
    let bankX = midX;
    for (let i = 0; i < 120 && pointInWater({ x: bankX, z: wetZ! }); i += 1) bankX += 0.2;
    const victim = sim.debugSpawn("soldier", "player", { x: bankX + 0.4, z: wetZ! });
    // Blast further east, so the throw carries the victim west, back over the bank.
    armed(sim, { x: bankX + 9, z: wetZ! });
    expect(sim.queueGrenadeAt({ x: bankX + 1.5, z: wetZ! })).toBe(true);
    sim.endTurn();
    settle(sim);

    expect(victim.status.alive, "a trooper thrown into the channel should drown").toBe(false);
    expect(sim.log.some((line) => /drown/i.test(line)), "and the log should say so").toBe(true);
  });

  it("leaves structures exactly where they stand", () => {
    const sim = staged();
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
    expect(base).toBeDefined();
    const before = { ...base!.position };
    armed(sim, { x: base!.position.x + 6, z: base!.position.z });
    expect(sim.queueGrenadeAt({ x: base!.position.x + 2.2, z: base!.position.z })).toBe(true);
    sim.endTurn();
    settle(sim);
    expect(base!.position.x).toBeCloseTo(before.x, 6);
    expect(base!.position.z).toBeCloseTo(before.z, 6);
  });
});
