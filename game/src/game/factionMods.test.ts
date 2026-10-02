import { describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { FACTIONS, unitModText } from "./factions";
import { DEFAULT_TERRAIN, setActiveTerrain } from "./terrain";

// FACTION TRAITS: the same unit plays differently per faction (owner 2026-10-03).
const sim = (player: "vanguard" | "syndicate" | "bastion"): TacticalSim => {
  const s = new TacticalSim();
  s.configure(mapDef("dustbowl"), "destroy", "normal", { player });
  return s;
};
const hp = (e: { parts: { maxHp: number }[] }): number => e.parts.reduce((n, p) => n + p.maxHp, 0);

describe("faction unit traits", () => {
  it("every faction tilts at least eight of its own units, within sane bounds, and only units it fields", () => {
    for (const f of FACTIONS) {
      const mods = f.unitMods ?? {};
      expect(Object.keys(mods).length, `${f.id}`).toBeGreaterThanOrEqual(8);
      for (const [kind, m] of Object.entries(mods)) {
        expect(f.roster.includes(kind as never), `${f.id} tilts ${kind} but does not field it`).toBe(true);
        for (const v of [m.hp, m.move, m.range, m.damage]) if (v !== undefined) { expect(v).toBeGreaterThanOrEqual(0.88); expect(v).toBeLessThanOrEqual(1.2); }
        expect(unitModText(f.id, kind as never)).not.toBe("");
      }
    }
  });

  it("each faction has its own character: Vanguard quick, Syndicate hard-hitting, Bastion tough", () => {
    const avg = (id: string, key: "move" | "hp" | "damage"): number => {
      const f = FACTIONS.find((x) => x.id === id)!;
      const vals = Object.values(f.unitMods ?? {}).map((m) => m[key] ?? 1);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    expect(avg("vanguard", "move")).toBeGreaterThan(avg("syndicate", "move"));
    expect(avg("vanguard", "move")).toBeGreaterThan(avg("bastion", "move"));
    expect(avg("syndicate", "damage")).toBeGreaterThan(avg("bastion", "damage"));
    expect(avg("bastion", "hp")).toBeGreaterThan(avg("syndicate", "hp"));
    expect(avg("bastion", "hp")).toBeGreaterThan(avg("vanguard", "hp"));
  });

  it("a Vanguard trooper is quicker and lighter than a Bastion guardsman, from the same unit", () => {
    const v = sim("vanguard"), b = sim("bastion");
    const vs = v.debugSpawn("soldier", "player", { x: -10, z: 0 });
    const bs = b.debugSpawn("soldier", "player", { x: -10, z: 0 });
    expect(vs.mods?.move).toBeGreaterThan(bs.mods?.move ?? 1);
    expect(hp(vs)).toBeLessThan(hp(bs));
    // ...and the move RING follows: walk the same order and the Vanguard unit goes further.
    v.debugSelect(vs.id); b.debugSelect(bs.id);
    const reach = (s: TacticalSim): number => { const r = s.previewMoveTo({ x: 40, z: 0 }); return r ? Math.hypot(r.to.x - r.from.x, r.to.z - r.from.z) : 0; };
    expect(reach(v)).toBeGreaterThan(reach(b));
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("a Syndicate raider carries an extra grenade, and its Longshot hits harder than a Vanguard marksman", () => {
    const sy = sim("syndicate"), va = sim("vanguard");
    expect(sy.debugSpawn("soldier", "player", { x: -10, z: 0 }).maxGrenades).toBe(va.debugSpawn("soldier", "player", { x: -10, z: 0 }).maxGrenades + 1);
    const shotAt = (s: TacticalSim): number => {
      const h = s.debugSpawn("sniper", "player", { x: -8, z: 0 });
      const t = s.debugSpawn("tank", "enemy", { x: 4, z: 0 });
      const part = t.parts.find((p) => p.role === "armor") ?? t.parts[0];
      return s.previewShot(h.id, t.id, part.id)?.amount ?? 0;
    };
    expect(shotAt(sy)).toBeGreaterThan(shotAt(va));
    setActiveTerrain(DEFAULT_TERRAIN);
  });

  it("traits ride a save", () => {
    const s = sim("bastion");
    const u = s.debugSpawn("soldier", "player", { x: -10, z: 0 });
    const loaded = new TacticalSim();
    expect(loaded.restore(s.serialize())).toBe(true);
    expect(loaded.entity(u.id)?.mods).toEqual(u.mods);
    setActiveTerrain(DEFAULT_TERRAIN);
  });
});
