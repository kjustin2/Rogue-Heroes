import "./style.css";

import { Stage } from "./render/stage";
import { WorldRenderer } from "./render/worldRenderer";
import { Hud } from "./ui/hud";
import { TacticalSim, type Intent } from "./game/sim";
import type { AimMode } from "./game/damageModel";

const canvas = document.getElementById("game") as HTMLCanvasElement | null;
const ui = document.getElementById("ui");

if (!canvas || !ui) throw new Error("Missing game canvas or UI root");
const uiRoot = ui;

const stage = new Stage(canvas);
const sim = new TacticalSim();
const world = new WorldRenderer(stage.scene);

const hud = new Hud(uiRoot, sim, {
  setIntent: (intent: Intent) => sim.setIntent(intent),
  endTurn: () => sim.endTurn(),
  reset: () => {
    sim.reset();
    if (sim.selected) stage.focusOn(sim.selected.position);
  },
  select: (id: string) => {
    sim.select(id);
    const entity = sim.entity(id);
    if (entity) stage.focusOn(entity.position);
  },
  deselect: () => sim.deselect(),
  queueMove: (destination) => sim.queueMove(destination),
  queueMoveToCover: (id: string) => sim.queueMoveToCover(id),
  queueTakeCover: (id: string) => sim.queueTakeCover(id),
  queueClimbCover: (id: string) => sim.queueClimbCover(id),
  queueShootPart: (id: string, partId: string) => sim.queueShootPart(id, partId),
  queueRam: (id: string) => sim.queueRam(id),
  queueMelee: (id: string) => sim.queueMelee(id),
  queueDefend: (stance) => sim.queueDefend(stance),
  cancelOrder: (id: string) => sim.cancelOrder(id),
  explainRamTarget: (id: string) => sim.explainRamTarget(id),
  explainMeleeTarget: (id: string) => sim.explainMeleeTarget(id),
});

let orbitingPointerId: number | undefined;
let orbitLastX = 0;
let orbitLastY = 0;

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 1) {
    event.preventDefault();
    orbitingPointerId = event.pointerId;
    orbitLastX = event.clientX;
    orbitLastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    return;
  }
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

canvas.addEventListener("pointermove", (event) => {
  if (orbitingPointerId !== event.pointerId) return;
  event.preventDefault();
  const deltaX = event.clientX - orbitLastX;
  const deltaY = event.clientY - orbitLastY;
  orbitLastX = event.clientX;
  orbitLastY = event.clientY;
  stage.orbitBy(deltaX * 0.008, -deltaY * 0.005);
});

const stopOrbit = (event: PointerEvent): void => {
  if (orbitingPointerId !== event.pointerId) return;
  orbitingPointerId = undefined;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
};

canvas.addEventListener("pointerup", stopOrbit);
canvas.addEventListener("pointercancel", stopOrbit);
canvas.addEventListener("auxclick", (event) => {
  if (event.button === 1) event.preventDefault();
});

const heldKeys = new Set<string>();

function clickArmedConfirm(): boolean {
  const button = uiRoot.querySelector<HTMLElement>("[data-confirm][data-disabled='false']");
  if (!button) return false;
  button.click();
  return true;
}

window.addEventListener("wheel", (event) => {
  if (shouldLetUiScroll(event)) return;
  event.preventDefault();
  stage.zoomBy(event.deltaY > 0 ? 0.08 : -0.08);
}, { passive: false });

function shouldLetUiScroll(event: WheelEvent): boolean {
  const target = event.target instanceof Element ? event.target : undefined;
  const scroller = target?.closest<HTMLElement>(".commandbar, .panel, .target-panel, .unit-detail-panel, .roster");
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return false;
  if (event.deltaY > 0) return scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
  if (event.deltaY < 0) return scroller.scrollTop > 0;
  return true;
}

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
    if (sim.selected) stage.focusOn(sim.selected.position);
  } else if (event.code === "Digit1") {
    hud.setAction("move");
  } else if (event.code === "Digit2") {
    hud.setAction("shoot");
  } else if (event.code === "Digit3") {
    hud.setAction("ram");
  } else if (event.code === "Digit4") {
    hud.setAction("defend");
  } else if (event.code === "KeyM") {
    hud.setAction("move");
  } else if (event.code === "KeyF") {
    hud.setAction("shoot");
  } else if (event.code === "KeyX") {
    hud.setAction("ram");
  } else if (event.code === "KeyV") {
    hud.setAction("defend");
  } else if (event.code === "KeyC") {
    if (sim.queueDefend("crouched")) hud.setAction("select");
  } else if (event.code === "Enter") {
    event.preventDefault();
    clickArmedConfirm();
  } else if (event.code === "Escape") {
    hud.setAction("select");
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
  world.update(sim, hud.focusedTargetId ?? hud.hoveredTargetId, hud.focusedPartId);
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
      deselect(): void;
      chooseBoardEntity(id: string): void;
      queueDefend(stance?: "standing" | "crouched" | "prone"): void;
      queueMoveToCover(id: string): boolean;
      queueTakeCover(id: string): boolean;
      queueClimbCover(id: string): boolean;
      queueMelee(id: string): boolean;
      cancelOrder(id: string): void;
      camera(): { x: number; z: number; zoom: number; yaw: number; pitch: number };
    };
  }
}

window.__rht = {
  sim,
  setIntent: (intent) => sim.setIntent(intent),
  setAim: (aim) => sim.setAim(aim),
  endTurn: () => sim.endTurn(),
  reset: () => {
    sim.reset();
    if (sim.selected) stage.focusOn(sim.selected.position);
  },
  deselect: () => sim.deselect(),
  chooseBoardEntity: (id) => hud.chooseBoardEntity(id),
  queueDefend: (stance) => sim.queueDefend(stance),
  queueMoveToCover: (id) => sim.queueMoveToCover(id),
  queueTakeCover: (id) => sim.queueTakeCover(id),
  queueClimbCover: (id) => sim.queueClimbCover(id),
  queueMelee: (id) => sim.queueMelee(id),
  cancelOrder: (id) => sim.cancelOrder(id),
  camera: () => stage.viewState(),
};
