import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, pointInWater, pointOnIce, setActiveTerrain } from "./terrain";

// ROUND 7 MAP FEATURES (owner 2026-10-07: "think of other fun things to add to maps ... more fun and unique"): the Ironworks
// freight train, Karak/Crossfire launch pads, Causeway thin ice and the red barrels on every map, each through the real sim.
const settle = (sim: TacticalSim, secs = 40): void => { for (let t = 0; t < secs && sim.phase === "resolve"; t += 0.05) sim.update(0.05); };
const board = (id: string): TacticalSim => {
  const sim = new TacticalSim();
  sim.configure(mapDef(id), "destroy", "normal");
  setActiveTerrain(mapDef(id).terrain);
  sim.economy.set("enemy", 0);
  for (const e of sim.entities) if (e.kind === "base") for (const p of e.parts) if (p.role === "weapon") p.hp = 0;
  return sim;
};
const pin = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
  e.status.canShoot = false; e.status.canMove = false;
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((s, p) => s + p.hp, 0);

describe("map features", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  it("the Ironworks train runs its tracks on its turn: the rails glow the turn before, and whoever stands on them is hit and thrown off", () => {
    const sim = board("ironworks");
    const track = mapDef("ironworks").train!.tracks[0];
    const mid = { x: (track.minX + track.maxX) / 2 + 2, z: (track.minZ + track.maxZ) / 2 };
    const victim = sim.debugSpawn("tank", "player", mid);
    const bystander = sim.debugSpawn("soldier", "enemy", { x: mid.x, z: track.maxZ + 4 });
    pin(victim); pin(bystander);
    const train = mapDef("ironworks").train!;
    while (sim.turn < train.startTurn - 1) { sim.endTurn(); settle(sim); }
    expect(sim.environment().rails.every((r) => r.state === "soon"), "the rails glow the turn before").toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.turn).toBe(train.startTurn);
    expect(sim.environment().rails.every((r) => r.state === "now")).toBe(true);
    const before = hp(victim), standers = hp(bystander);
    sim.endTurn(); settle(sim);
    const v = sim.entity(victim.id)!;
    expect(hp(v), "hit").toBeLessThan(before);
    expect(v.position.z >= track.minZ && v.position.z <= track.maxZ, "thrown off the track").toBe(false);
    expect(hp(sim.entity(bystander.id)!), "beside the line is safe").toBe(standers);
  });

  it("a launch pad flings a trooper that ends its move on it to the landing spot; a vehicle is not launched", () => {
    for (const id of ["karak", "crossfire"]) {
      const sim = board(id);
      const pad = sim.launchPads()[0];
      const t = sim.debugSpawn("soldier", "player", { x: pad.x - 2, z: pad.z });
      sim.debugSelect(t.id);
      expect(sim.queueMove({ x: pad.x, z: pad.z }), `${id}: ${sim.log[0]}`).toBe(true);
      sim.endTurn(); settle(sim);
      const at = sim.entity(t.id)!.position;
      expect(Math.hypot(at.x - pad.to.x, at.z - pad.to.z), `${id}: landed at the pad's spot`).toBeLessThan(1.6);
      expect(pointInWater(at)).toBe(false);
    }
  });

  it("Causeway thin ice: troopers walk it; a vehicle that stays on it cracks it, then goes through", () => {
    const sim = board("causeway");
    const ice = mapDef("causeway").terrain.ice![0];
    const spot = { x: (ice.minX + ice.maxX) / 2, z: (ice.minZ + ice.maxZ) / 2 };
    expect(pointOnIce(spot) && !pointInWater(spot), "ice is walkable").toBe(true);
    const tank = sim.debugSpawn("tank", "player", spot);
    pin(tank);
    sim.endTurn(); settle(sim);
    expect(sim.entity(tank.id)!.crackedTurn, "cracked").toBeDefined();
    expect(sim.entity(tank.id)!.status.alive).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(tank.id)!.status.alive, "went through").toBe(false);
  });

  it("every map has red barrels, and shooting one sets the stack off: it hurts whoever stands beside it", () => {
    for (const id of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
      expect(board(id).entities.filter((e) => e.coverKind === "barrels").length, id).toBe(2);
    }
    const sim = board("dustbowl");
    const barrels = sim.entities.find((e) => e.coverKind === "barrels")!;
    for (const p of barrels.parts) p.hp = 1;
    const near = sim.debugSpawn("soldier", "enemy", { x: barrels.position.x + 1.8, z: barrels.position.z });
    pin(near);
    const shooter = sim.debugSpawn("sniper", "player", { x: barrels.position.x - 10, z: barrels.position.z });
    const before = hp(near);
    sim.debugSelect(shooter.id);
    expect(sim.queueShoot(barrels.id), sim.log[0]).toBe(true);
    sim.endTurn(); settle(sim);
    expect(sim.entity(barrels.id)!.status.alive).toBe(false);
    expect(hp(sim.entity(near.id)!), "caught in the blast").toBeLessThan(before);
  });
});
