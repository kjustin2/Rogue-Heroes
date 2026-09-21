import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// BULLETS DO NOT GO THROUGH ITEMS. A blast wall is a 2.3m slab: a flat round crossing its outer
// third must hit it (the old disc test let anything 0.63m off-centre through); a round passing
// beside a wall that lies parallel to the line of fire must not.
const stage = (yaw: number, wallOffset: number) => {
  const sim = new TacticalSim(); sim.configure(mapDef("dustbowl"), "destroy", "normal");
  const Z = 2.5; // basin floor, off the central rise
  const a = sim.debugSpawn("soldier", "player", { x: -20, z: Z });
  const t = sim.debugSpawn("soldier", "enemy", { x: -13, z: Z });
  for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
  t.commandPoints = 0; t.maxCommandPoints = 0; // the AI must not walk the target off the line
  const w = sim.debugBuild("wall", "enemy", { x: -16.5, z: Z + wallOffset }); w.yaw = yaw;
  const wallHp = w.parts[0].hp, tHp = t.parts.reduce((s, p) => s + p.hp, 0);
  sim.debugSelect(a.id); expect(sim.queueShoot(t.id)).toBe(true); sim.endTurn();
  for (let i = 0; i < 400 && sim.phase === "resolve"; i += 1) sim.update(0.05);
  return { wallDmg: wallHp - w.parts[0].hp, targetDmg: tHp - t.parts.reduce((s, p) => s + p.hp, 0) };
};

describe("shot blocking by structures", () => {
  it("a wall across the line intercepts a round crossing its outer third", () => {
    const r = stage(Math.PI / 2, 0.8); // round passes 0.8m from the wall's centre along its length
    expect(r.wallDmg).toBeGreaterThan(0);
    expect(r.targetDmg).toBe(0);
  });
  it("a wall parallel to the line, beside it, does not", () => {
    const r = stage(0, 0.8); // 0.8m beside a 0.41m-thick slab
    expect(r.wallDmg).toBe(0);
    expect(r.targetDmg).toBeGreaterThan(0);
  });
});
