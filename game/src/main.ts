import "./style.css";

import { Stage } from "./render/stage";
import { WorldRenderer } from "./render/worldRenderer";
import { Hud } from "./ui/hud";
import { TacticalSim, type Intent } from "./game/sim";
import type { AimMode } from "./game/damageModel";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
const ui = document.getElementById("ui");

if (!canvas || !ui) throw new Error("Missing game canvas or UI root");

const stage = new Stage(canvas);
const sim = new TacticalSim();
const world = new WorldRenderer(stage.scene);

const hud = new Hud(ui, sim, {
  setIntent: (intent: Intent) => sim.setIntent(intent),
  setAim: (aim: AimMode) => sim.setAim(aim),
  endTurn: () => sim.endTurn(),
  reset: () => sim.reset(),
  select: (id: string) => sim.select(id),
});

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const pick = stage.pick(event.clientX, event.clientY, world.pickables);
  if (pick) {
    const entity = sim.entity(pick.entityId);
    if (!entity) return;
    if (sim.intent === "shoot" && entity.team !== "player") {
      sim.queueShoot(entity.id);
      return;
    }
    if (sim.intent === "ram" && entity.team !== "player") {
      sim.queueRam(entity.id);
      return;
    }
    sim.select(entity.id);
    return;
  }

  if (sim.intent === "move") {
    sim.queueMove(stage.screenToWorld(event.clientX, event.clientY));
  }
});

window.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.code === "Space") {
    event.preventDefault();
    sim.endTurn();
  } else if (event.code === "Tab") {
    event.preventDefault();
    sim.cyclePlayer();
  } else if (event.code === "Digit1") {
    sim.setIntent("select");
  } else if (event.code === "Digit2") {
    sim.setIntent("move");
  } else if (event.code === "Digit3") {
    sim.setIntent("shoot");
  } else if (event.code === "Digit4") {
    sim.setIntent("ram");
  } else if (event.code === "KeyR") {
    sim.reset();
  }
});

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  sim.update(dt);
  world.update(sim);
  hud.update();
  stage.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

declare global {
  interface Window {
    __rht: {
      sim: TacticalSim;
      setIntent(intent: Intent): void;
      setAim(aim: AimMode): void;
      endTurn(): void;
      reset(): void;
    };
  }
}

window.__rht = {
  sim,
  setIntent: (intent) => sim.setIntent(intent),
  setAim: (aim) => sim.setAim(aim),
  endTurn: () => sim.endTurn(),
  reset: () => sim.reset(),
};
