import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef, muzzleFor } from "./sim";
import { TROOP_KINDS } from "./units";

// 2026-10-03 owner: "gunship bullets appear to fire from above the gunship". Every round, preview line and flash starts at muzzleFor();
// the numbers in MUZZLE_LOCAL are read off the model builders, so these pins catch a table that drifts back to a ground unit's height.
describe("muzzles sit on the guns", () => {
  const sim = new TacticalSim();
  sim.configure(mapDef("dustbowl"), "destroy", "normal");
  const at = (kind: string) => sim.debugSpawn(kind as never, "player", { x: -10, z: 5 });

  it("an aircraft's gun and its bomb leave from UNDER the airframe, never above it", () => {
    for (const kind of ["gunship", "bomber"] as const) {
      const a = at(kind);
      expect(muzzleFor(a, "weapon").height, `${kind} gun`).toBeLessThan(a.elevation);
      expect(muzzleFor(a, "weapon").height, `${kind} gun`).toBeGreaterThan(a.elevation - 1);
    }
    const g = at("gunship");
    expect(muzzleFor(g, "grenade").height, "bomb rack is under the chin gun").toBeLessThan(muzzleFor(g, "weapon").height);
  });

  it("every shooter's barrel tip is out in front of its body and above the ground it stands on", () => {
    for (const kind of TROOP_KINDS) {
      const e = at(kind);
      if (e.flying) continue;
      const m = muzzleFor(e, "weapon");
      const reach = Math.hypot(m.point.x - e.position.x, m.point.z - e.position.z);
      expect(reach, `${kind} muzzle in front of its centre`).toBeGreaterThan(0.3);
      expect(m.height - e.elevation, `${kind} muzzle above its feet`).toBeGreaterThan(0.5);
    }
  });
});
