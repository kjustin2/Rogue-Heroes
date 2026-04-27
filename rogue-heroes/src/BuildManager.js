import { BUILD_DEFS } from "./defs.js";
import { FIELD } from "./BattleSim.js";

export class BuildManager {
  constructor(sim) {
    this.sim = sim;
    this.selected = "tower";
    this.message = "";
    this.messageTimer = 0;
    this.grid = 38;
    this.bounds = { ...FIELD };
    this.screenBounds = { ...FIELD };
    this.activeNodeId = sim.firstOwnedNode(0);
    this.selectedStructureId = null;
  }

  setScreenBounds(bounds) {
    this.screenBounds = { ...bounds };
  }

  select(type) {
    if (!BUILD_DEFS[type]) return;
    if (!this.sim.isBuildingUnlocked(0, type)) {
      this.setMessage("Unlock this from the tech tree first.");
      return;
    }
    this.selected = type;
    this.selectedStructureId = null;
  }

  setActiveBase(nodeId) {
    if (!this.sim.ownedNodes(0).some((node) => node.id === nodeId)) return false;
    this.activeNodeId = nodeId;
    this.selectedStructureId = null;
    return true;
  }

  selectStructureAt(x, y) {
    if (!inside(x, y, this.screenBounds)) return null;
    const world = this.screenToWorld(x, y);
    let best = null;
    let bestD = Infinity;
    for (const structure of this.sim.structuresForNode(0, this.activeNodeId)) {
      const def = BUILD_DEFS[structure.type];
      const d = distSq(world.x, world.y, structure.x, structure.y);
      const r = def.size * 0.7;
      if (d <= r * r && d < bestD) {
        best = structure;
        bestD = d;
      }
    }
    this.selectedStructureId = best?.id || null;
    return best;
  }

  selectedStructure() {
    return this.sim.structuresForNode(0, this.activeNodeId).find((structure) => structure.id === this.selectedStructureId) || null;
  }

  update(dt) {
    if (this.messageTimer > 0) this.messageTimer -= dt;
  }

  setMessage(text) {
    this.message = text;
    this.messageTimer = 2.0;
  }

  snap(x, y) {
    return this.snapWorld(x, y);
  }

  snapWorld(x, y) {
    return {
      x: Math.round(x / this.grid) * this.grid,
      y: Math.round(y / this.grid) * this.grid,
    };
  }

  screenToWorld(x, y) {
    const sx = this.bounds.w / this.screenBounds.w;
    const sy = this.bounds.h / this.screenBounds.h;
    return {
      x: this.bounds.x + (x - this.screenBounds.x) * sx,
      y: this.bounds.y + (y - this.screenBounds.y) * sy,
    };
  }

  worldToScreen(x, y) {
    const sx = this.screenBounds.w / this.bounds.w;
    const sy = this.screenBounds.h / this.bounds.h;
    return {
      x: this.screenBounds.x + (x - this.bounds.x) * sx,
      y: this.screenBounds.y + (y - this.bounds.y) * sy,
    };
  }

  canPlace(x, y) {
    const def = BUILD_DEFS[this.selected];
    if (
      x < this.screenBounds.x ||
      y < this.screenBounds.y ||
      x > this.screenBounds.x + this.screenBounds.w ||
      y > this.screenBounds.y + this.screenBounds.h
    ) {
      return { ok: false, reason: "Place inside the kingdom field." };
    }
    const world = this.screenToWorld(x, y);
    const p = this.snapWorld(world.x, world.y);
    const r = def.size * 0.62;
    if (
      p.x < this.bounds.x + r ||
      p.y < this.bounds.y + r ||
      p.x > this.bounds.x + this.bounds.w - r ||
      p.y > this.bounds.y + this.bounds.h - r
    ) {
      return { ok: false, reason: "Place inside the kingdom field." };
    }

    const core = { x: this.bounds.x + this.bounds.w / 2, y: this.bounds.y + this.bounds.h / 2 };
    if (distSq(p.x, p.y, core.x, core.y) < 70 * 70) {
      return { ok: false, reason: "Keep the core clear." };
    }

    for (const structure of this.sim.structuresForNode(0, this.activeNodeId)) {
      const otherDef = BUILD_DEFS[structure.type];
      const min = (def.size + otherDef.size) * 0.58;
      if (distSq(p.x, p.y, structure.x, structure.y) < min * min) {
        return { ok: false, reason: "Too close to another structure." };
      }
    }

    if (this.sim.player.gold < def.cost) return { ok: false, reason: "Not enough gold." };
    return { ok: true, x: p.x, y: p.y };
  }

  place(x, y) {
    if (this.selectStructureAt(x, y)) return true;
    const check = this.canPlace(x, y);
    if (!check.ok) {
      this.setMessage(check.reason);
      return false;
    }
    const result = this.sim.addStructure(this.sim.player.id, this.selected, check.x, check.y, false, this.activeNodeId);
    if (!result.ok) this.setMessage(result.reason);
    return result.ok;
  }
}

function inside(x, y, rect) {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
}

function distSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
