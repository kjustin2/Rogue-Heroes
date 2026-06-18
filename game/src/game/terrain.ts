import { clamp, type Vec2 } from "../core/math";

export const ARENA_BOUNDS = {
  minX: -18,
  maxX: 18,
  minZ: -12,
  maxZ: 12,
} as const;

export const ARENA_WIDTH = ARENA_BOUNDS.maxX - ARENA_BOUNDS.minX;
export const ARENA_DEPTH = ARENA_BOUNDS.maxZ - ARENA_BOUNDS.minZ;

export function clampToArena(v: Vec2): Vec2 {
  return {
    x: clamp(v.x, ARENA_BOUNDS.minX + 0.55, ARENA_BOUNDS.maxX - 0.55),
    z: clamp(v.z, ARENA_BOUNDS.minZ + 0.55, ARENA_BOUNDS.maxZ - 0.55),
  };
}

export function terrainHeightAt(point: Vec2): number {
  const northMesa = 1.28 * mesaMask(point);
  const windHill = ellipticalMound(point, { x: -5.8, z: -5.4 }, 6.4, 3.1, 0.46);
  const duneRise = ellipticalMound(point, { x: 8.1, z: -6.4 }, 4.8, 2.4, 0.58);
  const westernShoulder = ellipticalMound(point, { x: -10.2, z: 6.1 }, 4.2, 2.8, 0.34);
  const dryWash = ellipticalMound(point, { x: -1.7, z: -0.4 }, 7.2, 1.55, 0.24);
  const gully = ellipticalMound(point, { x: 5.1, z: 1.8 }, 3.8, 1.1, 0.18);
  const height = northMesa + windHill + duneRise + westernShoulder - dryWash - gully;
  return Math.max(0, Math.min(1.9, height));
}

function ellipticalMound(point: Vec2, center: Vec2, rx: number, rz: number, height: number): number {
  const x = (point.x - center.x) / rx;
  const z = (point.z - center.z) / rz;
  const d = x * x + z * z;
  if (d >= 1) return 0;
  const t = 1 - d;
  return height * t * t * (3 - 2 * t);
}

function mesaMask(point: Vec2): number {
  const x = smoothBand(point.x, -2.3, 5.7, 0.52);
  const z = smoothBand(point.z, 4.1, 8.85, 0.28);
  const shoulder = ellipticalMound(point, { x: 1.4, z: 6.3 }, 5.8, 3.0, 0.38);
  return clamp(x * z + shoulder, 0, 1);
}

function smoothBand(value: number, min: number, max: number, edge: number): number {
  return smoothStep((value - min) / edge) * smoothStep((max - value) / edge);
}

function smoothStep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}
