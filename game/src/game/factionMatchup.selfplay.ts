// FACTION MATCHUP SELF-PLAY (not a gate; ~5 min). Every pairing, both seats, every map, the same
// AI brain on both sides from bare bases (no free doctrine), 30 turns, undecided games scored on
// remaining army value. Prints wins per faction, per pairing, and what each side actually fielded.
// Run: npm run balance:factions  (SEEDS=37,59 / TURNS=40 / DIFF=hard to vary it).
// 2026-09-23, 4 seeds x 6 maps x 6 seatings = 144 games: Vanguard 32 / Syndicate 30 / Bastion 25,
// 57 draws. Rerun it after touching a roster, a doctrine or the AI economy.
import { MAPS, TacticalSim, mapDef, troopSpec, type TroopKind } from "./sim";
import { isBuildingKind, isDefenseKind } from "./damageModel";
import type { FactionId } from "./factions";

const FACTIONS: FactionId[] = ["vanguard", "syndicate", "bastion"];
const SEEDS = (process.env.SEEDS ?? "11,23").split(",").map(Number);
const MAX_TURNS = Number(process.env.TURNS ?? 30);
const DIFF = (process.env.DIFF ?? "normal") as "normal" | "hard";

function armyValue(sim: TacticalSim, team: "player" | "enemy"): number {
  let v = 0;
  for (const e of sim.entities) {
    if (e.team !== team || !e.status.alive || e.kind === "cover" || isBuildingKind(e.kind) || isDefenseKind(e.kind)) continue;
    const hp = e.parts.reduce((s, p) => s + p.hp, 0) / Math.max(1, e.parts.reduce((s, p) => s + p.maxHp, 0));
    v += troopSpec(e.kind as TroopKind).cost * hp;
  }
  return v;
}

const wins: Record<string, number> = { vanguard: 0, syndicate: 0, bastion: 0, draw: 0 };
const pair: Record<string, number> = {};
const fielded: Record<string, Record<string, number>> = { vanguard: {}, syndicate: {}, bastion: {} };
for (let i = 0; i < FACTIONS.length; i += 1) for (let j = i + 1; j < FACTIONS.length; j += 1) {
  for (const [a, b] of [[FACTIONS[i], FACTIONS[j]], [FACTIONS[j], FACTIONS[i]]]) {
    for (const map of MAPS) for (const seed of SEEDS) {
      const sim = new TacticalSim();
      sim.configure(mapDef(map.id), "destroy", DIFF, { player: a, enemy: b });
      sim.rng.reseed(seed);
      for (const base of sim.entities) if (base.kind === "base") base.unlockedTech = [];
      sim.economy.set("player", sim.money("enemy"));
      const seen = new Set<string>();
      for (let turn = 0; turn < MAX_TURNS && !sim.gameOver; turn += 1) {
        sim.debugCommandAsAi(DIFF);
        sim.endTurn();
        for (let t = 0; t < 40 && sim.phase === "resolve"; t += 0.05) sim.update(0.05);
        for (const e of sim.entities) {
          if (seen.has(e.id) || e.kind === "cover" || isBuildingKind(e.kind) || isDefenseKind(e.kind)) continue;
          seen.add(e.id);
          const f = e.team === "player" ? a : b;
          fielded[f][e.kind] = (fielded[f][e.kind] ?? 0) + 1;
        }
      }
      let winner: string;
      if (sim.phase === "victory") winner = a;
      else if (sim.phase === "defeat") winner = b;
      else {
        const p = armyValue(sim, "player"), e = armyValue(sim, "enemy");
        winner = p > e * 1.25 ? a : e > p * 1.25 ? b : "draw";
      }
      wins[winner] += 1;
      const key = `${[a, b].sort().join(" v ")}: ${winner}`;
      pair[key] = (pair[key] ?? 0) + 1;
    }
  }
}
console.log("wins", wins);
console.log(pair);
for (const f of FACTIONS) console.log(f, JSON.stringify(Object.entries(fielded[f]).sort((x, y) => y[1] - x[1])));
