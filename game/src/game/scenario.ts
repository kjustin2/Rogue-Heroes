import { createBase, type CombatEntity } from "./damageModel";
import { buildMapObjects, MAPS, type MapDef } from "./maps";
import type { ModeId } from "./modes";

// A battle starts with NO units on the field — only each side's Home Base plus the map's
// neutral cover. Both commanders deploy their forces from turn one.
export function createScenario(map: MapDef = MAPS[0], _mode: ModeId = "destroy"): CombatEntity[] {
  const playerBase = createBase("p-base-1", "Home Base", "player", { ...map.playerBase });
  const enemyBase = createBase("e-base-1", "Relay Base", "enemy", { ...map.enemyBase });
  // The enemy commander begins with one doctrine researched so it can field variety early.
  enemyBase.unlockedTech = ["assault"];
  return [playerBase, enemyBase, ...buildMapObjects(map)];
}
