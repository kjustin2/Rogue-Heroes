import { afterEach, describe, expect, it } from "vitest";
import { buildMapObjects, flagPositions, mapCenter, mapDef, MAPS, mapSize } from "./maps";
import { DEFAULT_TERRAIN, pointInWater, setActiveTerrain } from "./terrain";

const area = (b: { minX: number; maxX: number; minZ: number; maxZ: number }): number => (b.maxX - b.minX) * (b.maxZ - b.minZ);
const dist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

describe("map scaling + size tiers", () => {
  it("stamps a size tier on every enlarged map so mapSize never re-derives at runtime", () => {
    for (const m of MAPS) {
      expect(m.size, `${m.id} missing stamped size`).toBeDefined();
      expect(mapSize(m)).toBe(m.size);
    }
  });

  it("classifies the open maps as large and the cramped one as small, ordered by area", () => {
    expect(mapDef("dustbowl").size).toBe("large");
    expect(mapDef("causeway").size).toBe("large");
    expect(mapDef("ironworks").size).toBe("small");
    expect(area(mapDef("dustbowl").terrain.bounds)).toBeGreaterThan(area(mapDef("ironworks").terrain.bounds));
  });

  it("scales causeway's water and bridges and keeps them inside the enlarged bounds", () => {
    const c = mapDef("causeway");
    const b = c.terrain.bounds;
    expect(c.terrain.water?.length).toBeGreaterThan(0);
    expect(c.terrain.bridges?.length).toBeGreaterThan(0);
    for (const r of c.terrain.water ?? []) {
      expect(r.minX).toBeGreaterThanOrEqual(b.minX);
      expect(r.maxX).toBeLessThanOrEqual(b.maxX);
      expect(r.maxZ).toBeLessThanOrEqual(b.maxZ);
    }
  });
});

describe("map geometry", () => {
  it("mapCenter is the midpoint of the bounds", () => {
    const c = mapDef("ironworks");
    const b = c.terrain.bounds;
    expect(mapCenter(c)).toEqual({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });
  });

  it("flags sit flagOffset in front of each base, toward center", () => {
    for (const m of MAPS) {
      const center = mapCenter(m);
      const flags = flagPositions(m);
      expect(dist(m.playerBase, flags.player)).toBeCloseTo(m.flagOffset, 4);
      expect(dist(flags.player, center)).toBeLessThan(dist(m.playerBase, center)); // moved toward center
      expect(dist(m.enemyBase, flags.enemy)).toBeCloseTo(m.flagOffset, 4);
    }
  });

  it("mapDef returns the requested map and falls back to the first map for unknown ids", () => {
    expect(mapDef("verdant").id).toBe("verdant");
    expect(mapDef("does-not-exist")).toBe(MAPS[0]);
  });
});

describe("buildMapObjects", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN)); // restore the shared terrain singleton

  it("is deterministic per seed and never drops cover into a water channel", () => {
    const c = mapDef("causeway");
    setActiveTerrain(c.terrain); // pointInWater/steep checks read the active terrain
    const a = buildMapObjects(c);
    const b = buildMapObjects(c);
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((o) => ({ id: o.id, x: o.position.x, z: o.position.z }))).toEqual(
      b.map((o) => ({ id: o.id, x: o.position.x, z: o.position.z })),
    );
    for (const o of a) expect(pointInWater(o.position), `${o.id} sits in water`).toBe(false);
  });

  it("lays cover out symmetrically about the map center", () => {
    const c = mapDef("crossfire");
    setActiveTerrain(c.terrain);
    const center = mapCenter(c);
    const objs = buildMapObjects(c);
    // Every object has a point-symmetric partner (west/east mirroring is the fairness guarantee).
    for (const o of objs) {
      const mirror = { x: 2 * center.x - o.position.x, z: 2 * center.z - o.position.z };
      const hasPartner = objs.some((p) => dist(p.position, mirror) < 0.5);
      expect(hasPartner, `${o.id} has no mirrored partner`).toBe(true);
    }
  });
});
