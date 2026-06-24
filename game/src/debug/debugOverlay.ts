// ============================================================================
//  DebugOverlay — a toggleable 2D canvas drawn over the game that annotates each
//  entity with its id, kind, and HP at the projected screen position.
// ----------------------------------------------------------------------------
//  Purpose: make a screenshot self-describing. With the overlay on, a captured
//  frame shows "heavy p-spawn-3  60/80" floating over each unit, so a human or
//  the AI reviewing the shot can map pixels to game state without guessing.
//  Pure cosmetic + read-only — never touches the sim.
// ============================================================================

import type { SceneDescription } from "./diagnostics";

const TEAM_COLOR: Record<string, string> = {
  player: "#7ad7ff",
  enemy: "#ff8d6b",
  neutral: "#cdb98a",
};

export class DebugOverlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private enabled = false;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "debug-overlay";
    Object.assign(this.canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "40",
      display: "none",
    } as CSSStyleDeclaration);
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("DebugOverlay: 2D context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.style.display = on ? "block" : "none";
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  /** Redraw the annotations for the current scene. No-op while disabled. */
  render(scene: SceneDescription): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.textBaseline = "bottom";

    for (const e of scene.entities) {
      if (!e.screen || !e.screen.visible) continue;
      if (e.kind === "cover" || e.kind === "wall") continue; // structural clutter
      const color = TEAM_COLOR[e.team] ?? "#ffffff";
      const { x, y } = e.screen;

      // Marker dot.
      ctx.fillStyle = e.alive ? color : "#777";
      ctx.beginPath();
      ctx.arc(x, y, e.selected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Selection ring.
      if (e.selected) {
        ctx.strokeStyle = "#ffff7a";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Label: kind + short id, drawn above the dot with a readable backing.
      const tail = e.id.split("-").slice(-1)[0];
      const label = `${e.kind} ${tail}`;
      const hp = `${e.hp}/${e.maxHp}`;
      const labelW = Math.max(ctx.measureText(label).width, ctx.measureText(hp).width) + 8;
      const boxX = x - labelW / 2;
      const boxY = y - 34;
      ctx.fillStyle = "rgba(8,12,20,0.72)";
      ctx.fillRect(boxX, boxY, labelW, 28);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.fillText(label, x, boxY + 13);

      // HP bar under the label.
      const barW = labelW - 6;
      const barX = x - barW / 2;
      const barY = boxY + 18;
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(barX, barY, barW, 4);
      const pct = Math.max(0, Math.min(1, e.hpPct / 100));
      ctx.fillStyle = pct > 0.5 ? "#6be675" : pct > 0.25 ? "#f5c451" : "#ff5d5d";
      ctx.fillRect(barX, barY, barW * pct, 4);
    }

    // Corner banner so it's obvious the debug overlay is engaged.
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(8,12,20,0.72)";
    ctx.fillRect(8, 8, 220, 20);
    ctx.fillStyle = "#9dfcff";
    ctx.fillText(`DEBUG OVERLAY · ${scene.summary.slice(0, 30)}`, 12, 23);
  }
}
