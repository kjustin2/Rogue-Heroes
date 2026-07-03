import { createBase, createCover, createTurret, type CombatEntity } from "./damageModel";
import { buildMapObjects, MAPS, type MapDef } from "./maps";
import type { ModeId } from "./modes";

// A battle starts with NO units on the field — only each side's Home Base plus the map's
// neutral cover and any capturable field structures. Both commanders deploy from turn one.
export function createScenario(map: MapDef = MAPS[0], _mode: ModeId = "destroy"): CombatEntity[] {
  const playerBase = createBase("p-base-1", "Home Base", "player", { ...map.playerBase });
  const enemyBase = createBase("e-base-1", "Relay Base", "enemy", { ...map.enemyBase });
  // The enemy commander begins with one doctrine researched so it can field variety early.
  enemyBase.unlockedTech = ["assault"];
  return [playerBase, enemyBase, ...buildMapObjects(map), ...buildNeutralStructures(map)];
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
