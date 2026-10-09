// MAP FIT (owner 2026-10-08: "maps make sense with their layouts based on unit types"). A pure, headless measure of what each
// map offers each unit class, printed as one table:
//   tank routes  distinct tank-width routes base to base (each found route's corridor is banned before the next search)
//   path         the shortest tank route's length, metres (pace: long paths stall into draws)
//   squeeze      the narrowest clearance along it (metres either side of a tank's hull)
//   cover        share of the centre band's open ground within 3m of solid cover or a wall step (infantry)
//   perch        m^2 of walkable high ground >= 1.2m up (snipers, artillery spotters)
//   ring-out     share of the tank route within 4m of water, a drop or the board edge (somewhere for a throw to land)
// Run: npm run probe:map-fit
import { TacticalSim } from "./sim";
import { MAPS, mapDef } from "./maps";
import { TERRAIN_STEP, pointInWater, setActiveTerrain, terrainHeightAt, DEFAULT_TERRAIN } from "./terrain";
import { isDefenseKind } from "./damageModel";

const CELL = 0.5;
const TANK_R = 1.3;

type P = { x: number; z: number };

export interface MapFit { trace?: string; id: string; routes: number; path: number; squeeze: number; cover: number; perch: number; ringOut: number }

export function measureMapFit(id: string): MapFit {
  const map = mapDef(id);
  const sim = new TacticalSim();
  sim.configure(map, "destroy", "normal");
  setActiveTerrain(map.terrain);
  const b = map.terrain.bounds;
  const solids = sim.entities.filter((e) => e.status.alive && !e.flying && ((e.kind === "cover" && !["ridge", "span"].includes(e.coverKind ?? "")) || isDefenseKind(e.kind) || e.kind === "base"));
  const W = Math.round((b.maxX - b.minX) / CELL), H = Math.round((b.maxZ - b.minZ) / CELL);
  const at = (i: number, j: number): P => ({ x: b.minX + (i + 0.5) * CELL, z: b.minZ + (j + 0.5) * CELL });
  const ground = (p: P): boolean => !pointInWater(p);
  // Clearance: the largest radius (to 4m) a disc here can have with level ground and no solid prop in it.
  const clearance = (p: P, bases: boolean): number => {
    const h = terrainHeightAt(p);
    let best = 4;
    for (const s of solids) {
      if (!bases && s.kind === "base") continue;
      best = Math.min(best, Math.hypot(s.position.x - p.x, s.position.z - p.z) - s.radius);
    }
    for (let r = 0.25; r < best; r += 0.25) {
      for (let a = 0; a < 12; a += 1) {
        const q = { x: p.x + Math.cos(a * 0.5236) * r, z: p.z + Math.sin(a * 0.5236) * r };
        if (q.x < b.minX || q.x > b.maxX || q.z < b.minZ || q.z > b.maxZ || pointInWater(q) || Math.abs(terrainHeightAt(q) - h) > TERRAIN_STEP) return r;
      }
    }
    return best;
  };
  const clear = new Float32Array(W * H);
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    const p = at(i, j);
    clear[j * W + i] = ground(p) ? clearance(p, false) : 0;
  }
  const idx = (p: P): number => Math.max(0, Math.min(W - 1, Math.floor((p.x - b.minX) / CELL))) + Math.max(0, Math.min(H - 1, Math.floor((p.z - b.minZ) / CELL))) * W;
  // A tank goes from the edge of its base ring to the other's.
  const route = (banned: Uint8Array): number[] | undefined => {
    const start = idx({ x: map.playerBase.x + Math.sign(-map.playerBase.x || 1) * 5, z: map.playerBase.z });
    const goal = idx({ x: map.enemyBase.x + Math.sign(-map.enemyBase.x || -1) * 5, z: map.enemyBase.z });
    const prev = new Int32Array(W * H).fill(-1);
    const seen = new Uint8Array(W * H);
    const q = [start];
    seen[start] = 1;
    for (let k = 0; k < q.length; k += 1) {
      const c = q[k];
      if (c === goal) break;
      const ci = c % W, cj = Math.floor(c / W);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const n = nj * W + ni;
        if (seen[n] || banned[n] || clear[n] < TANK_R) continue;
        if (Math.abs(terrainHeightAt(at(ni, nj)) - terrainHeightAt(at(ci, cj))) > TERRAIN_STEP) continue;
        seen[n] = 1; prev[n] = c; q.push(n);
      }
    }
    if (!seen[goal]) return undefined;
    const path: number[] = [];
    for (let c = goal; c !== -1; c = prev[c]) path.push(c);
    return path;
  };
  const banned = new Uint8Array(W * H);
  const first = route(banned);
  let routes = 0;
  for (let r = first; r && routes < 4; r = route(banned)) {
    routes += 1;
    // Ban a 4m corridor round this route so the next one must be genuinely different.
    for (const c of r) {
      const ci = c % W, cj = Math.floor(c / W);
      for (let dj = -8; dj <= 8; dj += 1) for (let di = -8; di <= 8; di += 1) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H || di * di + dj * dj > 64) continue;
        const q = at(ni, nj);
        // ...but never the bases' own ends: every route has to leave one and reach the other.
        if (Math.hypot(q.x - map.playerBase.x, q.z - map.playerBase.z) < 9 || Math.hypot(q.x - map.enemyBase.x, q.z - map.enemyBase.z) < 9) continue;
        banned[nj * W + ni] = 1;
      }
    }
  }
  const path = first ? first.length * CELL : Infinity;
  const squeeze = first ? Math.min(...first.map((c) => clear[c])) - TANK_R : 0;
  const ringOut = first ? first.filter((c) => {
    const p = at(c % W, Math.floor(c / W));
    const h = terrainHeightAt(p);
    if (Math.min(p.x - b.minX, b.maxX - p.x, p.z - b.minZ, b.maxZ - p.z) < 4) return true;
    for (let a = 0; a < 12; a += 1) for (const r of [2, 4]) {
      const q = { x: p.x + Math.cos(a * 0.5236) * r, z: p.z + Math.sin(a * 0.5236) * r };
      if (pointInWater(q) || h - terrainHeightAt(q) > TERRAIN_STEP) return true;
    }
    return false;
  }).length / first.length : 0;
  // Infantry cover across the centre band (the middle third of the board).
  const cx = (b.minX + b.maxX) / 2, band = (b.maxX - b.minX) / 6;
  let open = 0, covered = 0, perch = 0;
  for (let j = 0; j < H; j += 1) for (let i = 0; i < W; i += 1) {
    const p = at(i, j);
    if (!ground(p)) continue;
    const h = terrainHeightAt(p);
    if (h >= 1.2) perch += CELL * CELL;
    if (Math.abs(p.x - cx) > band || clear[j * W + i] <= 0.3) continue;
    open += 1;
    const near = solids.some((s) => s.kind !== "base" && Math.hypot(s.position.x - p.x, s.position.z - p.z) < s.radius + 3)
      || [0, 1, 2, 3, 4, 5, 6, 7].some((a) => terrainHeightAt({ x: p.x + Math.cos(a * 0.785) * 2, z: p.z + Math.sin(a * 0.785) * 2 }) - h > 0.6);
    if (near) covered += 1;
  }
  setActiveTerrain(DEFAULT_TERRAIN);
  const trace = first ? first.filter((_, k) => k % 12 === 0).reverse().map((c) => { const p = at(c % W, Math.floor(c / W)); return `${p.x.toFixed(0)},${p.z.toFixed(0)}`; }).join(" ") : "";
  return { trace, id, routes, path, squeeze, cover: open ? covered / open : 0, perch, ringOut };
}

{
  console.log("map        routes  path(m)  squeeze  cover  perch(m2)  ring-out");
  for (const m of MAPS) {
    const f = measureMapFit(m.id);
    console.log(`${f.id.padEnd(10)} ${String(f.routes).padStart(6)}  ${f.path.toFixed(0).padStart(7)}  ${f.squeeze.toFixed(2).padStart(7)}  ${(f.cover * 100).toFixed(0).padStart(4)}%  ${f.perch.toFixed(0).padStart(9)}  ${(f.ringOut * 100).toFixed(0).padStart(7)}%`);
    if (process.env.TRACE) console.log("   ", f.trace);
  }
}
