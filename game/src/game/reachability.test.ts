import { afterEach, describe, expect, it } from "vitest";
import { MAPS, mapDef } from "./maps";
import { TacticalSim } from "./sim";
import { DEFAULT_TERRAIN, TERRAIN_STEP, pointInWater, setActiveTerrain, terrainHeightAt } from "./terrain";

// REACHABILITY.
//
// Impassable terrain in this game is emergent, not authored: nothing marks a tile as a wall. A
// cliff is just two stacked blocks whose combined step exceeds TERRAIN_STEP, and water blocks
// ground movement unless a bridge rect crosses it. That makes terrain expressive, and it also
// means a perfectly reasonable-looking edit -- raising a ridge, widening a channel, moving a
// bridge -- can silently wall a base off from the rest of the map. Nothing else in the suite
// would notice: every unit test still passes, and the battle simply becomes unwinnable.
//
// This floods the map from the player base over the SAME rules the sim's movement uses and
// asserts the enemy base, the objective hill, and open ground generally are all still reachable.
const STEP = 0.25; // finer than any unit radius, so a gap a unit could squeeze through is found

/** Mirrors the sim's ground-movement blockers: an unclimbable step, or unbridged water. */
const passable = (from: { x: number; z: number }, to: { x: number; z: number }): boolean => {
  if (pointInWater(to)) return false;
  return Math.abs(terrainHeightAt(to) - terrainHeightAt(from)) <= TERRAIN_STEP;
};

const flood = (map: (typeof MAPS)[number]): { seen: Set<string>; key: (p: { x: number; z: number }) => string } => {
  const { minX, maxX, minZ, maxZ } = map.terrain.bounds;
  const key = (p: { x: number; z: number }): string => `${Math.round(p.x / STEP)},${Math.round(p.z / STEP)}`;
  const snap = (p: { x: number; z: number }) => ({ x: Math.round(p.x / STEP) * STEP, z: Math.round(p.z / STEP) * STEP });
  const start = snap(map.playerBase);
  const seen = new Set<string>([key(start)]);
  const queue = [start];
  while (queue.length) {
    const at = queue.pop()!;
    for (const [dx, dz] of [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]] as const) {
      const next = { x: at.x + dx, z: at.z + dz };
      if (next.x < minX || next.x > maxX || next.z < minZ || next.z > maxZ) continue;
      const k = key(next);
      if (seen.has(k)) continue;
      if (!passable(at, next)) continue;
      seen.add(k);
      queue.push(next);
    }
  }
  return { seen, key };
};

describe("every map is winnable on foot", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN)); // the terrain singleton is shared state

  for (const map of MAPS) {
    describe(map.id, () => {
      it("connects the two bases", () => {
        setActiveTerrain(map.terrain);
        const { seen, key } = flood(map);
        const nearest = (p: { x: number; z: number }): boolean => {
          // Bases occupy real space, so accept any walkable cell within a base's footprint.
          for (let dx = -2; dx <= 2; dx += 1) {
            for (let dz = -2; dz <= 2; dz += 1) {
              if (seen.has(key({ x: p.x + dx * STEP * 4, z: p.z + dz * STEP * 4 }))) return true;
            }
          }
          return false;
        };
        expect(nearest(map.enemyBase), `${map.id}: enemy base is walled off from the player base`).toBe(true);
      });

      it("connects the objective hill", () => {
        // A hill nobody can stand on makes King-of-the-Hill and Domination unplayable on this map,
        // while Annihilation still works -- so it would ship broken for two modes out of five.
        setActiveTerrain(map.terrain);
        const { seen, key } = flood(map);
        let reachable = false;
        for (let dx = -4; dx <= 4 && !reachable; dx += 1) {
          for (let dz = -4; dz <= 4 && !reachable; dz += 1) {
            if (seen.has(key({ x: map.hill.x + dx * STEP, z: map.hill.z + dz * STEP }))) reachable = true;
          }
        }
        expect(reachable, `${map.id}: the objective hill cannot be reached on foot`).toBe(true);
      });

      it("keeps most of the battlefield open", () => {
        // Guards the other direction: terrain so aggressive that the map is technically connected
        // but is really a corridor. Flyers ignore all of this, ground units do not.
        setActiveTerrain(map.terrain);
        const { seen } = flood(map);
        const { minX, maxX, minZ, maxZ } = map.terrain.bounds;
        let open = 0;
        let total = 0;
        for (let x = minX; x <= maxX; x += STEP * 4) {
          for (let z = minZ; z <= maxZ; z += STEP * 4) {
            total += 1;
            if (!pointInWater({ x, z })) open += 1;
          }
        }
        const share = seen.size / ((open / total) * ((maxX - minX) / STEP) * ((maxZ - minZ) / STEP));
        expect(share, `${map.id}: only ${Math.round(share * 100)}% of walkable ground is reachable`).toBeGreaterThan(0.55);
      });
    });
  }
});

// DESTRUCTIBLE TERRAIN must not be able to make a map unwinnable. A player (or the AI) can drop any
// bridge span, and every authored crossing is therefore a way to change the map's connectivity
// mid-battle. This floods again after removing each span in turn -- the same assertion as above, but
// for every state the map can actually reach rather than only the state it ships in.
describe("dropping a bridge never strands a base", () => {
  afterEach(() => setActiveTerrain(DEFAULT_TERRAIN));

  for (const map of MAPS.filter((m) => (m.terrain.bridges?.length ?? 0) > 0)) {
    const spans = map.terrain.bridges ?? [];
    for (let index = 0; index < spans.length; index += 1) {
      it(`${map.id}: span ${index} can be destroyed`, () => {
        const sim = new TacticalSim();
        sim.configure(mapDef(map.id), "destroy", "normal");
        const rect = spans[index];
        const dropped = sim.dropBridgeAt({ x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 });
        expect(dropped, "the span could not be dropped").toBeGreaterThanOrEqual(0);

        const { seen, key } = flood(map);
        const reachable = (p: { x: number; z: number }): boolean => {
          for (let dx = -2; dx <= 2; dx += 1) {
            for (let dz = -2; dz <= 2; dz += 1) {
              if (seen.has(key({ x: p.x + dx * STEP * 4, z: p.z + dz * STEP * 4 }))) return true;
            }
          }
          return false;
        };
        expect(reachable(map.enemyBase), `${map.id}: dropping span ${index} strands the enemy base`).toBe(true);
      });
    }
  }
});

