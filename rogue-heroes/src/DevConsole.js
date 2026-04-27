export function initDevConsole(ctx) {
  window._dev = {
    ready: true,
    startRogueHeroes(seed = 12345) {
      ctx.restart(seed);
      return this.snapshot();
    },
    skipBuild() {
      ctx.skipBuild();
      return this.snapshot();
    },
    addGold(amount = 100) {
      ctx.sim.player.gold += amount;
      return ctx.sim.player.gold;
    },
    place(type, x, y) {
      ctx.build.select(type);
      return ctx.build.place(x, y);
    },
    setSpeed(speed) {
      if (ctx.battles) {
        ctx.battles.defense.speed = speed;
        ctx.battles.offense.speed = speed;
      } else {
        ctx.battle.speed = speed;
      }
    },
    forceWin() {
      for (const node of ctx.sim.nodes) node.owner = 0;
      ctx.setState("victory");
    },
    forceDefeat() {
      for (const node of ctx.sim.nodes) if (node.owner === 0) node.owner = 1;
      ctx.sim.updateEliminations();
      ctx.setState("defeat");
    },
    snapshot() {
      return {
        gameState: ctx.state,
        buildTimer: ctx.buildTimer,
        battle: ctx.battle.result,
        battles: ctx.battles ? {
          defense: ctx.battles.defense.result,
          offense: ctx.battles.offense.result,
        } : null,
        sim: ctx.sim.snapshot(),
      };
    },
  };
}
