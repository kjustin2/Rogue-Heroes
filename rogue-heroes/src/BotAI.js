import { BUILD_DEFS } from "./defs.js";

const BOT_BUILDS = ["farm", "tower", "guard_post", "raider_camp", "knight_stable", "wall", "siege_yard", "beam_obelisk", "nova_shrine", "ranger_range", "arcanum"];

export class BotAI {
  constructor(sim) {
    this.sim = sim;
  }

  takeBuildTurns() {
    for (const kingdom of this.sim.kingdoms) {
      if (kingdom.isPlayer || kingdom.eliminated) continue;
      if (kingdom.isNeutral) continue;
      let attempts = 0;
      while (kingdom.gold >= 12 && attempts < 10) {
        attempts++;
        const pressure = this.sim.territoryCount(kingdom.id) <= 2;
        const options = pressure
          ? ["tower", "guard_post", "wall", "farm", "raider_camp"]
          : BOT_BUILDS;
        const type = this.sim.rng.pick(options);
        const def = BUILD_DEFS[type];
        if (!def || kingdom.gold < def.cost) continue;
        if (!this.sim.isBuildingUnlocked(kingdom.id, type)) continue;
        const bases = this.sim.ownedNodes(kingdom.id);
        if (!bases.length) continue;
        const pos = this.pickBotPosition(type);
        this.sim.addStructure(kingdom.id, type, pos.x, pos.y, false, this.sim.rng.pick(bases).id);
      }
    }
  }

  takeFactoryTurns() {
    for (const kingdom of this.sim.kingdoms) {
      if (kingdom.isPlayer || kingdom.eliminated) continue;
      if (kingdom.isNeutral) continue;
      const options = ["workers", "machines", "logistics", "quality"];
      for (let i = 0; i < 2; i++) this.sim.upgradeFactory(kingdom.id, this.sim.rng.pick(options));
    }
  }

  pickBotPosition(type) {
    const isDefense = BUILD_DEFS[type].group !== "offense";
    const cx = 630;
    const cy = 360;
    const radius = isDefense ? this.sim.rng.int(70, 190) : this.sim.rng.int(150, 250);
    const angle = this.sim.rng.next() * Math.PI * 2;
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    };
  }
}
