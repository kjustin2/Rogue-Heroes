import { describe, expect, it } from "vitest";
import { damageLabel } from "./damageLabel";
import { TacticalSim, mapDef } from "../game/sim";
import { applyDamage } from "../game/damageModel";

describe("floating damage text", () => {
  const trooper = { isInfantry: true, isCover: false };
  it("K.I.A. only when the unit died", () => {
    expect(damageLabel({ killed: true, destroyed: true, amount: 40, partLabel: "Head" }, trooper)).toBe("K.I.A.");
    expect(damageLabel({ killed: true, destroyed: true, amount: 40, partLabel: "Hull" }, { isInfantry: false, isCover: false })).toBe("DESTROYED");
    expect(damageLabel({ killed: true, destroyed: true, amount: 40, partLabel: "Wall" }, { isInfantry: false, isCover: true })).toBe("DEMOLISHED");
  });

  it("a broken part is named, never K.I.A.", () => {
    const text = damageLabel({ killed: false, destroyed: true, amount: 22, partLabel: "Rifle" }, trooper);
    expect(text).toBe("RIFLE DOWN");
    expect(text).not.toMatch(/K\.I\.A/);
  });

  it("an ordinary hit is its number", () => {
    expect(damageLabel({ killed: false, destroyed: false, amount: 17, partLabel: "Body" }, trooper)).toBe("17");
  });

  it("the real sim agrees: breaking a trooper's weapon is destroyed-but-not-killed", () => {
    const sim = new TacticalSim();
    sim.configure(mapDef("dustbowl"), "destroy", "normal");
    const u = sim.debugSpawn("soldier", "player", { x: -10, z: 0 });
    const weapon = u.parts.find((p) => p.role === "weapon")!;
    const result = applyDamage(u, weapon.id, 999);
    expect(result.destroyed).toBe(true);
    expect(result.killed).toBe(false);
    expect(damageLabel({ killed: result.killed, destroyed: result.destroyed, amount: result.amount, partLabel: weapon.label }, trooper)).toMatch(/DOWN$/);
  });
});
