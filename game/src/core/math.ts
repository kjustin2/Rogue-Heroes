export interface Vec2 {
  x: number;
  z: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.z);
  return len > 0.0001 ? { x: v.x / len, z: v.z / len } : { x: 0, z: 0 };
}

export function moveToward(a: Vec2, b: Vec2, maxDist: number): Vec2 {
  const d = dist(a, b);
  if (d <= maxDist || d <= 0.0001) return { x: b.x, z: b.z };
  const t = maxDist / d;
  return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) };
}

export function pointToSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const ab2 = abx * abx + abz * abz;
  const t = ab2 > 0 ? clamp((apx * abx + apz * abz) / ab2, 0, 1) : 0;
  const x = a.x + abx * t;
  const z = a.z + abz * t;
  return Math.hypot(p.x - x, p.z - z);
}

export function segmentProgress(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 <= 0.0001) return 0;
  return clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / ab2, 0, 1);
}
