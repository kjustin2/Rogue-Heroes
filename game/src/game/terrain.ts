import { clamp, type Vec2 } from "../core/math";

export interface ArenaBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// A flat-topped raised rectangle. This is the only terrain primitive: stack several
// (overlapping footprints at increasing height) to build stepped mesas and high ground.
// Height is always >= 0 — there are no basins. Vertical sides make crisp, readable cover
// and reliably stop low projectiles.
export interface TerrainBlock {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}

export interface TerrainSpec {
  bounds: ArenaBounds;
  blocks?: TerrainBlock[];
  maxHeight?: number;
}

// The tallest single step a unit can climb in one stride. One authored block level sits
// at or below this, so infantry and vehicles can walk up onto a short ledge; stacking a
// second level forms an unclimbable wall/cliff.
export const TERRAIN_STEP = 0.95;

const DEFAULT_BOUNDS: ArenaBounds = { minX: -26, maxX: 26, minZ: -17, maxZ: 17 };

// ARENA_BOUNDS is a live, mutable singleton so existing consumers (camera, renderer)
// keep reading the active map's bounds without re-wiring.
export const ARENA_BOUNDS: ArenaBounds = { ...DEFAULT_BOUNDS };

let activeBlocks: TerrainBlock[] = [];
let activeMax = 1.9;

// The default terrain keeps a single raised mesa in the +z half so unit tests that don't
// load a map still see deterministic high ground (used by the line-of-sight / cover tests).
export const DEFAULT_TERRAIN: TerrainSpec = {
  bounds: { ...DEFAULT_BOUNDS },
  maxHeight: 1.9,
  blocks: [
    { minX: -1.5, maxX: 6, minZ: 3.8, maxZ: 9, height: 1.3 },
  ],
};

export function setActiveTerrain(spec: TerrainSpec): void {
  ARENA_BOUNDS.minX = spec.bounds.minX;
  ARENA_BOUNDS.maxX = spec.bounds.maxX;
  ARENA_BOUNDS.minZ = spec.bounds.minZ;
  ARENA_BOUNDS.maxZ = spec.bounds.maxZ;
  activeBlocks = (spec.blocks ?? []).map((b) => ({ ...b }));
  activeMax = spec.maxHeight ?? 1.9;
}

// Initialize to the default terrain so terrainHeightAt is always meaningful.
setActiveTerrain(DEFAULT_TERRAIN);

export function terrainBlocks(): readonly TerrainBlock[] {
  return activeBlocks;
}

export function arenaWidth(): number {
  return ARENA_BOUNDS.maxX - ARENA_BOUNDS.minX;
}

export function arenaDepth(): number {
  return ARENA_BOUNDS.maxZ - ARENA_BOUNDS.minZ;
}

export function clampToArena(v: Vec2): Vec2 {
  return {
    x: clamp(v.x, ARENA_BOUNDS.minX + 0.55, ARENA_BOUNDS.maxX - 0.55),
    z: clamp(v.z, ARENA_BOUNDS.minZ + 0.55, ARENA_BOUNDS.maxZ - 0.55),
  };
}

// Ground height at a point: the top of the tallest block whose footprint covers it, else 0.
export function terrainHeightAt(point: Vec2): number {
  let height = 0;
  for (const block of activeBlocks) {
    if (point.x >= block.minX && point.x <= block.maxX && point.z >= block.minZ && point.z <= block.maxZ) {
      if (block.height > height) height = block.height;
    }
  }
  return clamp(height, 0, activeMax);
}

// True when a point sits on (or very near) a vertical block edge — props placed here would
// straddle a cliff face and clip. Used by map authoring to keep cover on flat ground/tops.
export function onTerrainEdge(point: Vec2, margin = 0.6): boolean {
  const here = terrainHeightAt(point);
  for (const dx of [-margin, margin]) {
    for (const dz of [-margin, margin]) {
      if (Math.abs(terrainHeightAt({ x: point.x + dx, z: point.z + dz }) - here) > 0.05) return true;
    }
  }
  return false;
}
