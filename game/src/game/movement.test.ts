// THE MOVEMENT + PROJECTILE ORACLE (2026-09-24, owner: "most of the bugs I've seen is from units moving
// through the map or clipping or projectiles moving in the wrong way"). AI plays BOTH seats on every real
// map (props, bases, turrets, water, mesas) with the whole tech tree open, and every tick / turn end is
// checked against the rules the game promises:
//   projectiles (every tick): finite, flying FORWARD along their own direction, fired toward their aim
//     (never backwards), never tunnelling below the ground they fly over, inside the arena, and gone by
//     the end of their life;
//   ground units (every turn end): not standing INSIDE a solid prop / base / defense (a walk-through),
//     hull not cut into a terrain step, never sunk below the ground.
// The chaos bot (chaos.test.ts) covers random orders on bare terrain; this covers the real maps.
import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim } from "./sim";
import { mapDef } from "./maps";
import { ARENA_BOUNDS, DEFAULT_TERRAIN, TERRAIN_STEP, setActiveTerrain, terrainHeightAt } from "./terrain";
import { isDefenseKind, type CombatEntity } from "./damageModel";

const MAPS = ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"];
const TECH = ["assault", "armor", "recon", "ordnance", "support", "siege", "airwing"];
const DT = 0.05;

const solid = (e: CombatEntity): boolean =>
  e.status.alive && ((e.kind === "cover" && e.coverKind !== "ridge") || e.kind === "base" || isDefenseKind(e.kind));
const groundUnit = (e: CombatEntity): boolean =>
  e.status.alive && !e.flying && !e.carriedById && e.kind !== "cover" && e.kind !== "base" && !isDefenseKind(e.kind);
// A trooper standing ON low cover (the sim's climbable-cover rule) is a legal stance, not a walk-through.
const standingOn = (u: CombatEntity, c: CombatEntity): boolean =>
  c.kind === "cover" && u.elevation > terrainHeightAt(u.position) + 0.15;

function unitViolations(sim: TacticalSim, tag: string): string[] {
  const v: string[] = [];
  const units = sim.entities.filter(groundUnit);
  const solids = sim.entities.filter(solid);
  for (const u of units) {
    const ground = terrainHeightAt(u.position);
    if (u.elevation < ground - 0.06) v.push(`${tag}: ${u.name} sunk ${(ground - u.elevation).toFixed(2)}m below ground`);
    for (const s of solids) {
      if (s.id === u.id || standingOn(u, s)) continue;
      const d = Math.hypot(u.position.x - s.position.x, u.position.z - s.position.z);
      // Deeply inside: centres closer than 60% of the summed radii (a unit brushing a crate is fine).
      if (d < (u.radius + s.radius) * 0.6) v.push(`${tag}: ${u.name} inside ${s.name} (d=${d.toFixed(2)}, radii ${u.radius}+${s.radius})`);
    }
    // Hull in a step: a rise taller than a real step within most of the unit's own footprint.
    const reach = u.radius * 0.85;
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      const h = terrainHeightAt({ x: u.position.x + Math.sin(a) * reach, z: u.position.z + Math.cos(a) * reach });
      if (h - u.elevation > TERRAIN_STEP) { v.push(`${tag}: ${u.name} hull inside a ${(h - u.elevation).toFixed(2)}m step @(${u.position.x.toFixed(1)},${u.position.z.toFixed(1)})`); break; }
    }
  }
  return v;
}

function projectileViolations(sim: TacticalSim, tag: string, seen: Map<string, { travel: number; under: number }>): string[] {
  const v: string[] = [];
  // Rounds expire 1m past the rim; anything farther out is flying off the board.
  const margin = 1.5;
  for (const p of sim.projectiles) {
    const name = `${tag} ${p.kind}/${p.sourceKind ?? "?"} ${p.id}`;
    if (![p.position.x, p.position.z, p.height, p.travel].every(Number.isFinite)) { v.push(`${name}: non-finite state`); continue; }
    const first = !seen.has(p.id);
    const prev = seen.get(p.id);
    // Fired toward the aim, never backwards (a straight-down bomb has no horizontal leg to check).
    const aimX = p.aimPoint.x - p.origin.x, aimZ = p.aimPoint.z - p.origin.z;
    if (first && Math.hypot(aimX, aimZ) > 0.5 && (p.direction.x * aimX + p.direction.z * aimZ) < 0) v.push(`${name}: fired AWAY from its aim point`);
    // Always forward along its own line.
    if (prev && p.travel < prev.travel - 1e-6) v.push(`${name}: travel went backwards (${prev.travel.toFixed(2)} -> ${p.travel.toFixed(2)})`);
    const dx = p.position.x - p.previous.x, dz = p.position.z - p.previous.z;
    if (Math.hypot(dx, dz) > 1e-4 && (dx * p.direction.x + dz * p.direction.z) < -1e-4) v.push(`${name}: moved against its own direction`);
    // Never through the ground it flies over. One tick is allowed: a round fired from the foot of a step
    // can be born inside the face and is stopped by the ground check on its first step.
    const ground = terrainHeightAt(p.position);
    const under = p.height < ground - 0.35 ? (prev?.under ?? 0) + 1 : 0;
    if (under >= 2) v.push(`${name}: ${(ground - p.height).toFixed(2)}m underground for ${under} ticks @(${p.position.x.toFixed(1)},${p.position.z.toFixed(1)})`);
    if (p.position.x < ARENA_BOUNDS.minX - margin || p.position.x > ARENA_BOUNDS.maxX + margin || p.position.z < ARENA_BOUNDS.minZ - margin || p.position.z > ARENA_BOUNDS.maxZ + margin) {
      v.push(`${name}: left the arena @(${p.position.x.toFixed(1)},${p.position.z.toFixed(1)})`);
    }
    if (p.age > p.maxAge + 0.5) v.push(`${name}: outlived its life (${p.age.toFixed(1)}s > ${p.maxAge.toFixed(1)}s)`);
    seen.set(p.id, { travel: p.travel, under });
  }
  return v;
}

const MATCHUPS = [
  { player: "vanguard", enemy: "syndicate" },
  { player: "syndicate", enemy: "bastion" },
  { player: "bastion", enemy: "vanguard" },
] as const;

function playMap(id: string, seed: number, turns: number): string[] {
  const sim = new TacticalSim();
  // Three matchups per map, and each side fields its WHOLE faction roster from turn 1 (flyers,
  // vehicles, every infantry kind) so the whole unit set walks and shoots across every map.
  sim.configure(mapDef(id), "destroy", "normal", MATCHUPS[seed]);
  for (const team of ["player", "enemy"] as const) {
    const base = sim.entities.find((e) => e.kind === "base" && e.team === team)!;
    const toward = Math.sign(-base.position.x) || 1;
    sim.factionOf(team).roster.forEach((kind, i) => {
      sim.debugSpawn(kind, team, { x: base.position.x + toward * (7 + (i % 3) * 2.5), z: base.position.z + (Math.floor(i / 3) - 2) * 3 }, { clearTerrain: true });
    });
  }
  const v: string[] = [];
  const seen = new Map<string, { travel: number; under: number }>();
  for (let turn = 1; turn <= turns && sim.phase === "command"; turn += 1) {
    sim.economy.set("player", 4000);
    sim.economy.set("enemy", 4000);
    for (const b of sim.entities) if (b.kind === "base") b.unlockedTech = [...TECH];
    sim.debugCommandAsAi(); // the player seat plays too, so both armies roam the whole map
    sim.endTurn();
    for (let t = 0; t < 40 && (sim.phase as string) === "resolve"; t += DT) {
      sim.update(DT);
      v.push(...projectileViolations(sim, `${id}/s${seed}/t${turn}`, seen));
    }
    v.push(...unitViolations(sim, `${id}/s${seed}/t${turn}`));
  }
  return v;
}

describe("movement + projectile oracle (AI vs AI on every real map)", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  for (const id of MAPS) {
    it(`${id}: no walk-throughs, no step clipping, no wrong-way or underground rounds`, () => {
      const all = [0, 1, 2].flatMap((seed) => playMap(id, seed, 12));
      // Report distinct problems, not every tick of the same one.
      const distinct = [...new Set(all.map((s) => s.replace(/ p-\d+| proj-\d+|@\([^)]*\)|\d+\.\d+m/g, "")))];
      expect(distinct.slice(0, 20), all.slice(0, 20).join("\n")).toEqual([]);
    }, 120_000);
  }
});
