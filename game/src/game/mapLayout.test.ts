import { afterEach, describe, expect, it } from "vitest";
import { isLandmarkKind } from "./damageModel";
import { MAPS } from "./maps";
import { TacticalSim, mapDef } from "./sim";
import { DEFAULT_TERRAIN, setActiveTerrain, terrainHeightAt } from "./terrain";

// 2026-10-06 (owner: "objects on the ground overlap ... like turrets and supply caches"). Every map, as the game lays it out:
// nothing on the ground touches anything else (props, posts, neutral turrets, cash caches, mines), and no prop straddles a
// terrain step half sunk or half floating (a landmark authored `hug: true` into its step is the one exception).
describe("map layout: nothing overlaps, nothing straddles a step", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  for (const map of MAPS) {
    it(map.id, () => {
      const sim = new TacticalSim(); sim.configure(mapDef(map.id), "destroy", "normal"); setActiveTerrain(map.terrain);
      const things: { n: string; x: number; z: number; r: number }[] = [];
      for (const e of sim.entities) if (e.status.alive && !e.flying && !["ridge", "cliff", "span", "wall"].includes(e.coverKind ?? "")) things.push({ n: `${e.kind}/${e.coverKind ?? ""}`, x: e.position.x, z: e.position.z, r: e.radius + (isLandmarkKind(e.coverKind) ? 1.7 : 0) }); // landmarks draw past their footprint
      for (const p of sim.pickups) things.push({ n: "cache", x: p.x, z: p.z, r: 0.6 });
      const overlaps: string[] = [];
      for (let i = 0; i < things.length; i++) for (let j = i + 1; j < things.length; j++) {
        const a = things[i], b = things[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + 0.3) overlaps.push(`${a.n} x ${b.n}`);
      }
      expect(overlaps).toEqual([]);
      const hugs = new Set((map.signature ?? []).filter((s) => s.hug).map((s) => s.kind));
      const straddles: string[] = [];
      for (const e of sim.entities) {
        if (!e.status.alive || e.flying || hugs.has(e.coverKind as never) || ["ridge", "cliff", "wall", "span"].includes(e.coverKind ?? "")) continue;
        const hs = [terrainHeightAt(e.position)];
        for (let a = 0; a < 16; a++) for (const f of [0.5, 1]) hs.push(terrainHeightAt({ x: e.position.x + Math.cos(a * 0.3927) * e.radius * f, z: e.position.z + Math.sin(a * 0.3927) * e.radius * f }));
        if (Math.max(...hs) - Math.min(...hs) > 0.3) straddles.push(`${e.kind}/${e.coverKind ?? ""} @${e.position.x.toFixed(1)},${e.position.z.toFixed(1)}`);
      }
      expect(straddles).toEqual([]);
    });
  }
});
