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
  endTurn: () => sim.endTurn(),
  reset: () => sim.reset(),
  select: (id: string) => sim.select(id),
  queueMove: (destination) => sim.queueMove(destination),
  queueMoveToCover: (id: string) => sim.queueMoveToCover(id),
  queueShootPart: (id: string, partId: string) => sim.queueShootPart(id, partId),
  queueRam: (id: string) => sim.queueRam(id),
  queueDefend: () => sim.queueDefend(),
  cancelOrder: (id: string) => sim.cancelOrder(id),
});

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const pick = stage.pick(event.clientX, event.clientY, world.pickables);
  if (pick) {
    const entity = sim.entity(pick.entityId);
    if (!entity) return;
    hud.chooseBoardEntity(entity.id);
    return;
  }

  hud.chooseGround(stage.screenToWorld(event.clientX, event.clientY));
});

const heldKeys = new Set<string>();

window.addEventListener("wheel", (event) => {
  event.preventDefault();
  stage.zoomBy(event.deltaY > 0 ? 0.08 : -0.08);
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if (["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code)) {
    event.preventDefault();
    heldKeys.add(event.code);
    return;
  }
  if (event.repeat) return;
  if (event.code === "Space") {
    event.preventDefault();
    sim.endTurn();
  } else if (event.code === "Tab") {
    event.preventDefault();
    sim.cyclePlayer();
  } else if (event.code === "Digit1") {
    hud.setAction("select");
  } else if (event.code === "Digit2") {
    hud.setAction("move");
  } else if (event.code === "Digit3") {
    hud.setAction("shoot");
  } else if (event.code === "Digit4") {
    hud.setAction("ram");
  } else if (event.code === "KeyR") {
    hud.resetGame();
  }
});

window.addEventListener("keyup", (event) => {
  heldKeys.delete(event.code);
});

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stage.update(dt, {
    up: heldKeys.has("KeyW"),
    down: heldKeys.has("KeyS"),
    left: heldKeys.has("KeyA"),
    right: heldKeys.has("KeyD"),
  });
  sim.update(dt);
  world.update(sim, hud.focusedTargetId, hud.focusedPartId);
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
      queueDefend(): void;
      queueMoveToCover(id: string): boolean;
      cancelOrder(id: string): void;
      camera(): { x: number; z: number; zoom: number };
    };
  }
}

window.__rht = {
  sim,
  setIntent: (intent) => sim.setIntent(intent),
  setAim: (aim) => sim.setAim(aim),
  endTurn: () => sim.endTurn(),
  reset: () => sim.reset(),
  queueDefend: () => sim.queueDefend(),
  queueMoveToCover: (id) => sim.queueMoveToCover(id),
  cancelOrder: (id) => sim.cancelOrder(id),
  camera: () => stage.viewState(),
};
