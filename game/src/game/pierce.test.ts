import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";

// Item 5 of the fun pass: the marksman's round goes THROUGH bodies and hits everyone on the line.
const settle = (sim: TacticalSim): void => {
  for (let t = 0; t < 80 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
};
const hp = (e: { parts: { hp: number }[] }): number => e.parts.reduce((sum, p) => sum + p.hp, 0);
const pin = (e: ReturnType<TacticalSim["debugSpawn"]>): void => {
  for (const p of e.parts) if (p.role === "mobility") p.hp = 0;
  e.status.canMove = false;
};

describe("piercing rounds", () => {
  it("a marksman hits a second body standing behind the first; a rifleman does not", () => {
    for (const [kind, expectPierce] of [["sniper", true], ["soldier", false]] as const) {
      const sim = new TacticalSim();
      sim.configure(mapDef("dustbowl"), "destroy", "normal");
      const shooter = sim.debugSpawn(kind, "player", { x: -6, z: 0 });
      const front = sim.debugSpawn("heavy", "enemy", { x: 0, z: 0 });
      const behind = sim.debugSpawn("heavy", "enemy", { x: 2.2, z: 0 });
      pin(front); pin(behind);
      // Pinned bodies still shoot back; take their guns so only the marksman's shot lands.
      for (const e of [front, behind]) { for (const p of e.parts) if (p.role === "weapon") p.hp = 0; e.status.canShoot = false; }
      const behindBefore = hp(behind);
      sim.debugSelect(shooter.id);
      // Aim at the rear body's centre so the line passes through the front one on the way.
      const part = behind.parts.find((p) => p.role === "core")!;
      expect(sim.queueShootPart(behind.id, part.id)).toBe(true);
      // Pin the shot's aim: no rng spread, so the round is on the line both bodies stand on.
      const order = sim.orders[sim.orders.length - 1];
      order.aim = "center";
      sim.endTurn();
      settle(sim);
      const hitBehind = hp(behind) < behindBefore;
      expect(hitBehind, `${kind}: rear body hit`).toBe(expectPierce);
      if (expectPierce) expect(sim.log.some((l) => l.includes("goes clean through"))).toBe(true);
    }
  });
});
