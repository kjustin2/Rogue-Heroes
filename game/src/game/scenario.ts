import { createBase, createCover, createTurret, type CombatEntity } from "./damageModel";
import { buildMapObjects, MAPS, type MapDef } from "./maps";
import type { ModeId } from "./modes";

// A battle starts with NO units on the field — only each side's Home Base plus the map's
// neutral cover and any capturable field structures. Both commanders deploy from turn one.
/**
 * A destructible span on every authored bridge crossing.
 *
 * Bridges were pure terrain, so there was nothing to shoot: the most consequential destructible on
 * the board could not be destroyed. Each authored bridge rect now carries one span entity at its
 * centre; killing it drops the crossing for the rest of the battle (see TacticalSim.dropBridgeAt).
 * The entity is neutral -- a bridge belongs to whoever is standing on it.
 */
function createBridgeSpans(map: MapDef): CombatEntity[] {
  const spans: CombatEntity[] = [];
  const bridges = map.terrain.bridges ?? [];
  for (let i = 0; i < bridges.length; i += 1) {
    const r = bridges[i];
    spans.push(createCover(
      `span-${map.id}-${i}`,
      "Bridge Span",
      { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 },
      { coverKind: "span" },
    ));
  }
  return spans;
}

export function createScenario(map: MapDef = MAPS[0], mode: ModeId = "destroy"): CombatEntity[] {
  const playerBase = createBase("p-base-1", "Home Base", "player", { ...map.playerBase });
  // Last Stand has no enemy base — the threat is the waves themselves.
  if (mode === "survival") return [playerBase, ...buildMapObjects(map), ...buildNeutralStructures(map), ...createBridgeSpans(map)];
  const enemyBase = createBase("e-base-1", "Relay Base", "enemy", { ...map.enemyBase });
  // The enemy commander begins with one doctrine researched so it can field variety early.
  enemyBase.unlockedTech = ["assault"];
  return [playerBase, enemyBase, ...buildMapObjects(map), ...buildNeutralStructures(map), ...createBridgeSpans(map)];
}

// Capturable neutral structures: derelict turrets and supply depots that flip to the
// team with a unit standing beside them at the start of a turn.
function buildNeutralStructures(map: MapDef): CombatEntity[] {
  const out: CombatEntity[] = [];
  let seq = 0;
  for (const spec of map.neutrals ?? []) {
    const spots = spec.mirror
      ? [{ x: spec.x, z: spec.z }, { x: -spec.x, z: -spec.z }]
      : [{ x: spec.x, z: spec.z }];
    for (const spot of spots) {
      seq += 1;
      if (spec.kind === "turret") {
        const turret = createTurret(`neutral-turret-${map.id}-${seq}`, "Derelict Turret", "neutral", spot);
        turret.capturable = true;
        turret.commandPoints = 0;
        out.push(turret);
      } else {
        const depot = createCover(`neutral-depot-${map.id}-${seq}`, "Supply Depot", spot, { coverKind: "depot" });
        depot.capturable = true;
        out.push(depot);
      }
    }
  }
  return out;
}
