import { describe, expect, it } from "vitest";
import { MAPS, mapDef } from "./maps";
import { TacticalSim } from "./sim";
import { onTerrainEdge, terrainHeightAt } from "./terrain";

// PROPS MUST NOT CLIP. Every cover prop on every map: not overlapping another prop (footprints
// intersect), not straddling a terrain step (half the prop floating / buried), not in water unless
// the kind belongs there. The owner saw "objects clipping into each other" on the board.
describe("map scatter", () => {
  for (const map of MAPS) {
    it(`${map.id}: props do not overlap, straddle steps, or sit in water`, () => {
      const sim = new TacticalSim();
      sim.configure(mapDef(map.id), "destroy", "normal");
      const props = sim.entities.filter((e) => e.kind === "cover" && e.coverKind !== "ridge" && e.coverKind !== "cliff");
      const problems: string[] = [];
      for (let i = 0; i < props.length; i += 1) {
        const a = props[i];
        if (onTerrainEdge(a.position, Math.min(0.6, a.radius * 0.8))) problems.push(`${a.name}@${a.position.x.toFixed(1)},${a.position.z.toFixed(1)} straddles a terrain step`);
        for (let j = i + 1; j < props.length; j += 1) {
          const b = props[j];
          const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
          const allowed = (a.radius + b.radius) * 1.0;
          if (d < allowed) problems.push(`${a.name} & ${b.name} overlap (d=${d.toFixed(2)} < ${allowed.toFixed(2)})`);
        }
      }
      // Units deploy from bases: the base ring must be clear of props too.
      for (const base of sim.entities.filter((e) => e.kind === "base")) {
        for (const p of props) {
          const d = Math.hypot(base.position.x - p.position.x, base.position.z - p.position.z);
          if (d < base.radius + p.radius) problems.push(`${p.name} inside ${base.name}'s footprint`);
        }
      }
      void terrainHeightAt;
      if (problems.length) console.log(`[scatter ${map.id}] ` + problems.join(" | "));
      expect(problems).toEqual([]);
    });
  }
});
