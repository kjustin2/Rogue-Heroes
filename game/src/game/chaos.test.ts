import { afterEach, describe, expect, it } from "vitest";
import { createHeavy, createScout, createSoldier, createStriker, createTank, type CombatEntity } from "./damageModel";
import { TacticalSim } from "./sim";
import { ARENA_BOUNDS, DEFAULT_TERRAIN, pointInWater, setActiveTerrain } from "./terrain";
import { mapDef } from "./maps";

// A seeded chaos bot: it fires RANDOM LEGAL orders at the sim for many turns and checks invariant
// ORACLES after every resolve. This is the only coverage for the chronic collision classes —
// walk-through-a-wall, stack-on-another-unit, escape-the-arena, in-water, NaN — which no scripted
// scenario catches. The sim is pure + deterministic, so a printed seed reproduces any failure.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isGround = (e: CombatEntity): boolean => !e.flying && !e.carriedById;

// Return a list of invariant violations for the current sim state (empty = healthy).
function auditInvariants(sim: TacticalSim, tag: string): string[] {
  const v: string[] = [];
  const living = sim.entities.filter((e) => e.status.alive && !e.carriedById);
  for (const e of living) {
    // NO-NAN
    if (!Number.isFinite(e.position.x) || !Number.isFinite(e.position.z)) v.push(`${tag}: ${e.id} NaN pos`);
    // IN-BOUNDS (movement clamps to ARENA_BOUNDS + 0.55; anything past the raw edge is a leak)
    if (e.position.x < ARENA_BOUNDS.minX - 0.1 || e.position.x > ARENA_BOUNDS.maxX + 0.1 ||
        e.position.z < ARENA_BOUNDS.minZ - 0.1 || e.position.z > ARENA_BOUNDS.maxZ + 0.1) {
      v.push(`${tag}: ${e.id} out of bounds @(${e.position.x.toFixed(1)},${e.position.z.toFixed(1)})`);
    }
    // HP SANITY
    for (const p of e.parts) {
      if (!Number.isFinite(p.hp) || p.hp < -0.01 || p.hp > p.maxHp + 0.01) v.push(`${tag}: ${e.id}.${p.id} hp ${p.hp}/${p.maxHp}`);
    }
    // NO-WATER: a ground unit must never end resolved standing in an impassable water channel.
    if (isGround(e) && pointInWater(e.position)) v.push(`${tag}: ${e.id} standing in water @(${e.position.x.toFixed(1)},${e.position.z.toFixed(1)})`);
  }
  // NO-OVERLAP: two living ground units must never deeply interpenetrate (walked through each
  // other). Flag when centers are closer than HALF the sum of radii — a clear visual merge, not
  // just the exact-coincident case.
  const ground = living.filter(isGround);
  for (let i = 0; i < ground.length; i += 1) {
    for (let j = i + 1; j < ground.length; j += 1) {
      const d = Math.hypot(ground[i].position.x - ground[j].position.x, ground[i].position.z - ground[j].position.z);
      const limit = (ground[i].radius + ground[j].radius) * 0.5;
      if (d < limit) v.push(`${tag}: ${ground[i].id} & ${ground[j].id} overlap (d=${d.toFixed(2)} < ${limit.toFixed(2)})`);
    }
  }
  return v;
}

// Drive one full turn of random legal player orders, then let the AI act, then resolve to completion.
function chaosTurn(sim: TacticalSim, rng: () => number): void {
  const bounds = ARENA_BOUNDS;
  const randPoint = () => ({ x: bounds.minX + rng() * (bounds.maxX - bounds.minX), z: bounds.minZ + rng() * (bounds.maxZ - bounds.minZ) });
  const mine = sim.entities.filter((e) => e.team === "player" && e.status.alive && !e.carriedById);
  for (const u of mine) {
    let guard = 0;
    while (u.commandPoints > 0 && guard++ < 4) {
      sim.select(u.id);
      const roll = rng();
      if (roll < 0.6) {
        if (!sim.queueMove(randPoint())) break; // bias toward movement — it stresses collision hardest
      } else if (roll < 0.85) {
        const foe = sim.entities.find((e) => e.team === "enemy" && e.status.alive && !e.carriedById);
        if (!foe || !sim.queueShoot(foe.id)) { if (!sim.queueMove(randPoint())) break; }
      } else {
        if (!sim.queueDefend(rng() < 0.5 ? "crouched" : "prone")) break;
      }
    }
  }
  sim.endTurn();
  for (let t = 0; t < 24 && sim.phase !== "command"; t += 0.05) sim.update(0.05); // resolve to completion
}

function runChaos(seed: number, mapId?: string): string[] {
  const rng = mulberry32(seed);
  const roster = (team: "player" | "enemy", sign: number): CombatEntity[] => {
    const make = [createSoldier, createStriker, createScout, createHeavy, createTank];
    return make.map((f, i) => f(`${team}-${i}`, `${team}${i}`, team, { x: sign * (6 + i * 1.5), z: (i - 2) * 2.4 }));
  };
  const sim = new TacticalSim([...roster("player", -1), ...roster("enemy", 1)]);
  if (mapId) setActiveTerrain(mapDef(mapId).terrain); // exercise this map's water/bridges/blocks
  sim.economy.set("player", 4000);
  sim.economy.set("enemy", 4000);

  const violations: string[] = [];
  violations.push(...auditInvariants(sim, `seed${seed}/setup`));
  for (let turn = 0; turn < 8 && !sim.gameOver; turn += 1) {
    chaosTurn(sim, rng);
    if (sim.phase !== "command" && !sim.gameOver) violations.push(`seed${seed}/turn${turn}: resolve never settled (phase=${sim.phase})`);
    violations.push(...auditInvariants(sim, `seed${seed}/turn${turn}`));
    // Save/restore round-trip mid-run must not corrupt state or trip any oracle either.
    const saved = sim.serialize();
    if (!sim.restore(saved)) violations.push(`seed${seed}/turn${turn}: restore failed`);
    violations.push(...auditInvariants(sim, `seed${seed}/turn${turn}-restored`));
  }
  return violations;
}

describe("chaos bot — random legal orders never break sim invariants", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN)); // restore the shared terrain singleton

  for (const seed of [1337, 2024, 90210, 5, 777]) {
    it(`open terrain holds all invariants (seed ${seed})`, () => {
      expect(runChaos(seed)).toEqual([]);
    });
  }

  // Every real map's terrain (water channels, mesas, walls, chokepoints) gets stress-tested — these
  // are exactly the shapes that trap the separation/collision resolver.
  for (const mapId of ["causeway", "dustbowl", "ironworks", "verdant", "karak", "crossfire"]) {
    it(`map ${mapId} holds all invariants`, () => {
      const all: string[] = [];
      for (const seed of [1337, 2024, 90210]) all.push(...runChaos(seed, mapId));
      expect(all).toEqual([]);
    });
  }
});
