import { afterEach, describe, expect, it } from "vitest";
import { isLandmarkKind, isMountKind } from "./damageModel";
import { MAPS } from "./maps";
import { TacticalSim, mapDef } from "./sim";
import { ARENA_BOUNDS, DEFAULT_TERRAIN, setActiveTerrain, terrainHeightAt } from "./terrain";

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
      // Nothing the layout sets down hangs off the board (smoke:ground's rule, 0.05m slack): a post's contact shadow (1.25x radius),
      // a cache's 0.74m ring. Authored landmarks are placed by hand and exempt.
      const b = ARENA_BOUNDS;
      const reach = (t: { n: string; r: number }): number => (t.n === "cache" ? 0.74 : isMountKind(t.n.split("/")[0] as never) ? t.r * 1.25 : 0);
      const offEdge = things.filter((t) => reach(t) > 0 && Math.min(t.x - b.minX, b.maxX - t.x, t.z - b.minZ, b.maxZ - t.z) < reach(t) - 0.05);
      expect(offEdge.map((t) => `${t.n} @${t.x.toFixed(1)},${t.z.toFixed(1)}`)).toEqual([]);
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

// Supply caches come in mirrored pairs through the map centre (2026-10-07: Karak scattered six of seven onto one half).
describe("supply caches are fair", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  for (const map of MAPS) {
    it(map.id, () => {
      const sim = new TacticalSim(); sim.configure(mapDef(map.id), "destroy", "normal");
      const b = map.terrain.bounds, cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      expect(sim.pickups.length).toBeGreaterThanOrEqual(2);
      const lonely = sim.pickups.filter((p) => !sim.pickups.some((q) => q !== p && q.amount === p.amount && Math.hypot(q.x - (2 * cx - p.x), q.z - (2 * cz - p.z)) < 0.05));
      expect(lonely).toEqual([]);
    });
  }
});

// The map features stay clear: nothing set down on a freight track.
describe("map features are clear", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  for (const map of MAPS.filter((m) => m.train)) {
    it(map.id, () => {
      const sim = new TacticalSim(); sim.configure(mapDef(map.id), "destroy", "normal"); setActiveTerrain(map.terrain);
      const things = [
        ...sim.entities.filter((e) => e.status.alive && !["ridge", "cliff", "span", "wall"].includes(e.coverKind ?? "") && e.kind !== "base").map((e) => ({ n: `${e.kind}/${e.coverKind ?? ""}`, x: e.position.x, z: e.position.z, r: e.radius })),
        ...sim.pickups.map((p) => ({ n: "cache", x: p.x, z: p.z, r: 0.74 })),
      ];
      const blocking = things.filter((t) => sim.onMapFeature(t, t.r * 0.9));
      expect(blocking.map((t) => `${t.n} @${t.x.toFixed(1)},${t.z.toFixed(1)}`)).toEqual([]);
    });
  }
});

// THE BOARD EDGE (owner 2026-10-07: "parts of map don't spill out ... a circle went off the border"). Every ring the game draws
// on the ground lies wholly on the board: the hill zone, every hazard zone's marked circle. (Caches and posts are held above; deploy rings are fitted by fitBases; the ground paint and plates are clipped to the
// board in the renderer -- shots:gpu -- corners.)
describe("every drawn ring is on the board", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  for (const map of MAPS) {
    it(map.id, () => {
      const sim = new TacticalSim(); sim.configure(mapDef(map.id), "hill", "normal"); setActiveTerrain(sim.mapDef.terrain);
      const b = ARENA_BOUNDS;
      const rings: { n: string; x: number; z: number; r: number }[] = [{ n: "hill", ...sim.mapDef.hill, r: sim.mapDef.hillRadius }];
      for (const e of sim.mapDef.events ?? []) if (e.zone) rings.push({ n: `event ${e.kind}`, x: e.zone.x, z: e.zone.z, r: e.zone.radius });
      const off = rings.filter((t) => Math.min(t.x - b.minX, b.maxX - t.x, t.z - b.minZ, b.maxZ - t.z) < t.r - 0.05);
      expect(off.map((t) => `${t.n} @${t.x.toFixed(1)},${t.z.toFixed(1)} r${t.r}`)).toEqual([]);
    });
  }
});
