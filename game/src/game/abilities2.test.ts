import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Unit identity abilities, round two: the mortar's Walking Fire salvo.
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

describe("mortar salvo (Walking Fire, 2026-10-07: replaces the smoke round)", () => {
  it("three lighter shells land in a line through the spot, short, on it and long", () => {
    const sim = staged();
    const mortar = sim.debugSpawn("mortar", "player", { x: -14, z: 0 });
    // Three foes down the mortar's line to the spot, two metres apart: each shell lands on one.
    const foes = [-2, 0, 2].map((dx) => { const f = sim.debugSpawn("soldier", "enemy", { x: 2 + dx, z: 0 }); disarm(f); return f; });
    const before = foes.map(hp);
    sim.debugSelect(mortar.id);
    expect(sim.queueSalvoAt({ x: 2, z: 0 }), sim.log[0]).toBe(true);
    sim.endTurn();
    settle(sim);
    // The first shells throw troopers clear of the later ones, so at least two of the three are hit.
    expect(foes.filter((f, i) => hp(sim.entity(f.id)!) < before[i]).length).toBeGreaterThanOrEqual(2);
  });

  it("is a mortar-only order", () => {
    const sim = staged();
    const rifle = sim.debugSpawn("soldier", "player", { x: -14, z: 0 });
    sim.debugSelect(rifle.id);
    expect(sim.queueSalvoAt({ x: 0, z: 0 })).toBe(false);
  });
});
