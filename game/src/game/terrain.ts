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

// A flat rectangular footprint on the ground plane (no height). Used for impassable water and
// the walkable bridge strips that cross it.
export interface TerrainRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface TerrainSpec {
  bounds: ArenaBounds;
  blocks?: TerrainBlock[];
  maxHeight?: number;
  // Impassable water: ground units cannot enter these footprints (flyers overfly). Water sits at
  // ground level so it does not block flat line-of-fire.
  water?: TerrainRect[];
  // Walkable strips that cross water — a unit inside a bridge rect ignores the water blocker.
  bridges?: TerrainRect[];
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
let activeWater: TerrainRect[] = [];
let activeBridges: TerrainRect[] = [];

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
  activeWater = (spec.water ?? []).map((r) => ({ ...r }));
  activeBridges = (spec.bridges ?? []).map((r) => ({ ...r }));
}

/** A snapshot of the live terrain, so a caller that swaps it for one synchronous call can put it back. */
export function activeTerrainSpec(): TerrainSpec {
  return {
    bounds: { ...ARENA_BOUNDS },
    blocks: activeBlocks.map((b) => ({ ...b })),
    maxHeight: activeMax,
    water: activeWater.map((r) => ({ ...r })),
    bridges: activeBridges.map((r) => ({ ...r })),
  };
}

const inRect = (p: Vec2, r: TerrainRect): boolean => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;

export function terrainWater(): readonly TerrainRect[] {
  return activeWater;
}

export function terrainBridges(): readonly TerrainRect[] {
  return activeBridges;
}

// True when a point sits in impassable water and NOT on a bridge that crosses it. Ground movement
// is blocked here; flyers and the renderer ignore it.
export function pointInWater(point: Vec2): boolean {
  if (activeWater.length === 0) return false;
  if (!activeWater.some((r) => inRect(point, r))) return false;
  return !activeBridges.some((r) => inRect(point, r));
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

// Nudge a point out of impassable water onto the nearest dry ground, spiralling outward.
//
// Ground units must never be PLACED standing in water. Movement already refuses to enter it, but
// placement (deploying at a base, an airlift unload, a debug spawn, a test building entities
// directly) bypasses movement entirely, so without this a unit can be dropped into a channel and
// is then stuck in a state the movement rules say is impossible. Returns the point unchanged when
// it is already dry, and gives up gracefully rather than looping if a map is somehow all water.
export function nearestDryPoint(point: Vec2, maxRadius = 8): Vec2 {
  if (!pointInWater(point)) return point;
  for (let radius = 0.5; radius <= maxRadius; radius += 0.5) {
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2;
      const candidate = clampToArena({ x: point.x + Math.cos(angle) * radius, z: point.z + Math.sin(angle) * radius });
      if (!pointInWater(candidate)) return candidate;
    }
  }
  return point;
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

/** A move path's climbs: where the ground rises by at least `minRise` on the way from `from` to `to`.
 *  Each climb reports the TOP of the rise (where the unit lands after stepping up) and its height.
 *  Pure and sampled on the sim terrain, so the move preview and the real walk agree. */
export function climbsAlong(from: Vec2, to: Vec2, minRise = 0.3, spacing = 0.2): Array<{ point: Vec2; rise: number }> {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(length / spacing));
  const out: Array<{ point: Vec2; rise: number }> = [];
  let prev = terrainHeightAt(from);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const point = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    const h = terrainHeightAt(point);
    if (h - prev >= minRise) out.push({ point, rise: h - prev });
    prev = h;
  }
  return out;
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
