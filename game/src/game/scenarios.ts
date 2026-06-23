// ============================================================================
//  Debug scenarios — named, deterministic battle states for automated tests and
//  screenshots. Each scenario reconfigures the sim and stages a specific
//  situation so a capture script can "cut to" it with one call
//  (window.__rht.scenario(id)) instead of driving the whole UI.
// ============================================================================

import { mapDef } from "./maps";
import type { TacticalSim } from "./sim";
import type { TroopKind } from "./units";

export interface Scenario {
  id: string;
  title: string;
  description: string;
  apply(sim: TacticalSim): void;
}

// Lay a row of units of given kinds for a team, centred-ish on (x0, z).
function row(sim: TacticalSim, kinds: TroopKind[], team: "player" | "enemy", x0: number, z: number, dx: number): void {
  kinds.forEach((k, i) => sim.debugSpawn(k, team, { x: x0 + i * dx, z }));
}

export const SCENARIOS: Scenario[] = [
  {
    id: "roster",
    title: "Unit roster",
    description: "Every player unit type laid out in a grid — for at-a-glance differentiation.",
    apply(sim) {
      sim.configure(mapDef("ironworks"), "destroy", "normal");
      sim.debugGrant("player", 5000);
      const kinds: TroopKind[] = ["soldier", "scout", "sniper", "striker", "heavy", "grenadier", "mortar", "medic", "engineer", "tank", "apc", "artillery"];
      const cols = 4;
      kinds.forEach((k, i) => {
        const u = sim.debugSpawn(k, "player", { x: -4.2 + (i % cols) * 2.7, z: -3.6 + Math.floor(i / cols) * 2.7 });
        u.commandPoints = 0;
      });
      sim.deselect();
    },
  },
  {
    id: "siege",
    title: "Siege the enemy base",
    description: "Player armor + siege column advancing on a walled, turret-defended enemy base.",
    apply(sim) {
      sim.configure(mapDef("karak"), "destroy", "normal");
      sim.debugGrant("player", 5000);
      const eb = sim.mapDef.enemyBase;
      const dir = Math.sign(sim.mapDef.playerBase.x - eb.x) || -1;
      // Enemy base ringed with walls + a gun turret + a mortar turret.
      sim.debugBuild("wall", "enemy", { x: eb.x + dir * 4, z: eb.z - 2 });
      sim.debugBuild("wall", "enemy", { x: eb.x + dir * 4, z: eb.z + 2 });
      sim.debugBuild("turret", "enemy", { x: eb.x + dir * 3, z: eb.z + 4 });
      sim.debugBuild("exturret", "enemy", { x: eb.x + dir * 3, z: eb.z - 4 });
      sim.debugSpawn("heavy", "enemy", { x: eb.x + dir * 5, z: eb.z });
      // Player siege column a short distance off, ready to fire.
      const tank = sim.debugSpawn("tank", "player", { x: eb.x + dir * 11, z: eb.z - 1.6 });
      sim.debugSpawn("artillery", "player", { x: eb.x + dir * 13, z: eb.z + 1.6 });
      sim.debugSpawn("grenadier", "player", { x: eb.x + dir * 11.5, z: eb.z + 3.4 });
      sim.debugSelect(tank.id);
      sim.setIntent("select");
    },
  },
  {
    id: "firefight",
    title: "Cover firefight",
    description: "Two infantry squads trading fire across scattered cover at mid range.",
    apply(sim) {
      sim.configure(mapDef("verdant"), "destroy", "normal");
      sim.debugGrant("player", 5000);
      const c = { x: 0, z: 0 };
      row(sim, ["soldier", "sniper", "heavy"], "player", c.x - 9, c.z - 2, 2.2);
      row(sim, ["soldier", "scout", "striker"], "enemy", c.x + 6, c.z + 2, 2.2);
      const shooter = sim.entities.find((e) => e.team === "player" && e.kind === "sniper");
      if (shooter) {
        sim.debugSelect(shooter.id);
        sim.setIntent("shoot");
      }
    },
  },
  {
    id: "grenade-arc",
    title: "Grenade over a wall",
    description: "A soldier lobbing a grenade with a wall directly in the throw path (blocked-arc preview).",
    apply(sim) {
      sim.configure(mapDef("ironworks"), "destroy", "normal");
      sim.debugGrant("player", 5000);
      const thrower = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
      sim.debugBuild("wall", "enemy", { x: -2, z: 0 }); // a wall squarely in the throw path
      sim.debugSpawn("heavy", "enemy", { x: 3, z: 0 });
      sim.debugSelect(thrower.id);
      sim.setIntent("grenade");
    },
  },
  {
    id: "high-ground",
    title: "High-ground overwatch",
    description: "A marksman on raised terrain overlooking enemies on the flat below.",
    apply(sim) {
      sim.configure(mapDef("causeway"), "destroy", "normal");
      sim.debugGrant("player", 5000);
      // Find a raised spot on the map's terrain to perch the sniper.
      const perch = highestSpot(sim);
      const sniper = sim.debugSpawn("sniper", "player", perch);
      sim.debugSpawn("scout", "player", { x: perch.x + 1.6, z: perch.z + 1.2 });
      row(sim, ["soldier", "heavy", "striker"], "enemy", 4, -1, 2.4);
      sim.debugSelect(sniper.id);
      sim.setIntent("shoot");
    },
  },
  {
    id: "base-defense",
    title: "Hold the base",
    description: "Enemy armor assaulting a player base fortified with walls and turrets.",
    apply(sim) {
      sim.configure(mapDef("dustbowl"), "destroy", "normal");
      sim.debugGrant("player", 5000);
      const pb = sim.mapDef.playerBase;
      const dir = Math.sign(sim.mapDef.enemyBase.x - pb.x) || 1;
      sim.debugBuild("wall", "player", { x: pb.x + dir * 4, z: pb.z });
      sim.debugBuild("turret", "player", { x: pb.x + dir * 3, z: pb.z - 3 });
      sim.debugBuild("exturret", "player", { x: pb.x + dir * 3, z: pb.z + 3 });
      sim.debugSpawn("heavy", "player", { x: pb.x + dir * 5.5, z: pb.z - 1.5 });
      sim.debugSpawn("tank", "enemy", { x: pb.x + dir * 11, z: pb.z - 1 });
      sim.debugSpawn("heavy", "enemy", { x: pb.x + dir * 12, z: pb.z + 2 });
      sim.debugSpawn("soldier", "enemy", { x: pb.x + dir * 10, z: pb.z + 3.5 });
      sim.deselect();
    },
  },
  {
    id: "victory",
    title: "Victory end screen",
    description: "Player force standing, enemy eliminated — the victory report.",
    apply(sim) {
      sim.configure(mapDef("ironworks"), "destroy", "normal");
      row(sim, ["soldier", "heavy", "tank"], "player", -4, 0, 2.6);
      sim.debugDefeatTeam("enemy");
      sim.deselect();
      sim.debugSetPhase("victory");
    },
  },
  {
    id: "defeat",
    title: "Defeat end screen",
    description: "Enemy force standing, player eliminated — the defeat report.",
    apply(sim) {
      sim.configure(mapDef("ironworks"), "destroy", "normal");
      row(sim, ["soldier", "heavy", "tank"], "enemy", 2, 0, 2.6);
      sim.debugDefeatTeam("player");
      sim.deselect();
      sim.debugSetPhase("defeat");
    },
  },
];

// The highest authored terrain block centre on the active map (for high-ground staging).
function highestSpot(sim: TacticalSim): { x: number; z: number } {
  const blocks = sim.mapDef.terrain.blocks ?? [];
  if (!blocks.length) return { x: -6, z: 0 };
  const top = blocks.reduce((a, b) => (b.height > a.height ? b : a));
  return { x: (top.minX + top.maxX) / 2, z: (top.minZ + top.maxZ) / 2 };
}

export const SCENARIO_IDS: string[] = SCENARIOS.map((s) => s.id);

export function scenarioInfo(): Array<{ id: string; title: string; description: string }> {
  return SCENARIOS.map(({ id, title, description }) => ({ id, title, description }));
}

export function applyScenario(sim: TacticalSim, id: string): boolean {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) return false;
  scenario.apply(sim);
  return true;
}
