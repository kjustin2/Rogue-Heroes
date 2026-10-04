import { afterEach, describe, expect, it } from "vitest";
import { TacticalSim, mapDef } from "./sim";
import { TROOP_KINDS } from "./units";
import { ARENA_BOUNDS, DEFAULT_TERRAIN, pointInWater, setActiveTerrain } from "./terrain";
function rngf(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function run(seed: number, mapId: string): string[] {
  const r = rngf(seed); const sim = new TacticalSim(); sim.configure(mapDef(mapId), "destroy", "hard"); setActiveTerrain(mapDef(mapId).terrain);
  sim.economy.set("player", 5000); sim.economy.set("enemy", 5000);
  const out: string[] = []; const b = ARENA_BOUNDS; const pt = () => ({ x: b.minX + r() * (b.maxX - b.minX), z: b.minZ + r() * (b.maxZ - b.minZ) });
  for (let turn = 0; turn < 9 && !sim.gameOver; turn += 1) {
    const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
    for (let k = 0; k < 3 && base; k += 1) { const kind = TROOP_KINDS[Math.floor(r() * TROOP_KINDS.length)]; const a = r() * 6.28; sim.debugSpawn(kind, "player", { x: base.position.x + Math.cos(a) * 6, z: base.position.z + Math.sin(a) * 6 }); }
    for (const u of sim.entities.filter((e) => e.team === "player" && e.status.alive && !e.carriedById && e.kind !== "base")) {
      let g = 0;
      while (u.commandPoints > 0 && g++ < 4) {
        sim.select(u.id);
        const foes = sim.entities.filter((e) => e.team === "enemy" && e.status.alive && !e.carriedById); const foe = foes[Math.floor(r() * foes.length)];
        const mates = sim.entities.filter((e) => e.team === "player" && e.status.alive && e.id !== u.id); const mate = mates[Math.floor(r() * mates.length)];
        const roll = r(); let ok = false;
        try {
          if (roll < 0.25) ok = sim.queueMove(pt()); else if (roll < 0.45 && foe) ok = sim.queueShoot(foe.id); else if (roll < 0.5) ok = sim.queueSlam(); else if (roll < 0.55) ok = sim.queueDig();
          else if (roll < 0.6) ok = sim.queueLeap(pt()); else if (roll < 0.65) ok = sim.queuePlace(pt()); else if (roll < 0.72 && mate) ok = sim.queueLoad(mate.id); else if (roll < 0.77) ok = sim.queueUnload(pt());
          else if (roll < 0.82 && mate) ok = sim.queueMan(mate.id); else if (roll < 0.85) ok = sim.queueDismount(); else if (roll < 0.9 && foe) ok = sim.queueMelee(foe.id); else if (roll < 0.94 && foe) ok = sim.queueShove(foe.id);
          else if (roll < 0.97) ok = sim.queueBombDrop(pt()); else ok = sim.queueGrenadeAt(pt());
        } catch (e) { out.push(`${u.kind} threw: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`); }
        if (!ok && !sim.queueMove(pt())) break;
      }
    }
    try { sim.endTurn(); for (let t = 0; t < 40 && sim.phase !== "command" && !sim.gameOver; t += 0.05) sim.update(0.05); } catch (e) { out.push(`resolve threw: ${(e as Error).stack?.split("\n").slice(0, 4).join(" | ")}`); break; }
    if (sim.phase !== "command" && !sim.gameOver) out.push(`seed${seed}/${mapId}/t${turn} never settled`);
    for (const e of sim.entities) { if (!e.status.alive) continue; const p = e.position;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) out.push(`${e.id}(${e.kind}) NaN`);
      if (!e.carriedById && (p.x < b.minX - 0.1 || p.x > b.maxX + 0.1 || p.z < b.minZ - 0.1 || p.z > b.maxZ + 0.1)) out.push(`${e.kind} OOB`);
      for (const part of e.parts) if (!Number.isFinite(part.hp) || part.hp < -0.01 || part.hp > part.maxHp + 0.01) out.push(`${e.kind}.${part.id} hp ${part.hp}`);
      if (!e.flying && !e.carriedById && pointInWater(p) && e.kind !== "cover") out.push(`${e.kind} in water`);
      if (e.carriedById) { const c = sim.entity(e.carriedById); if (!c || !c.status.alive) out.push(`${e.kind} carried by dead`); } }
    if (!sim.restore(sim.serialize())) out.push("restore failed");
  }
  return out;
}
describe("chaos with the whole roster and every order", () => { afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));
  for (const map of ["causeway", "dustbowl", "ironworks", "verdant", "karak", "crossfire"]) it(`map ${map}`, () => { const all: string[] = []; for (const seed of [11, 3333]) all.push(...run(seed, map)); console.log(map, [...new Set(all)].slice(0, 12).join(" || ")); expect(all.slice(0, 10)).toEqual([]); }, 200000); });
