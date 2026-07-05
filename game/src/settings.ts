// Persisted player settings: audio mute/volume, default bot difficulty, reduced motion.

import type { Difficulty } from "./game/sim";

const KEY = "rht.settings.v1";

// Resolve-phase pacing: how fast queued orders play out. 1 = default; <1 slower, >1 faster.
export type ActionPace = "slow" | "normal" | "fast";
export const ACTION_PACES: readonly ActionPace[] = ["slow", "normal", "fast"];
export const PACE_SPEED: Record<ActionPace, number> = { slow: 0.6, normal: 1, fast: 1.8 };
export const PACE_LABEL: Record<ActionPace, string> = { slow: "Slow", normal: "Default", fast: "Fast" };

// Graphics quality = how many pixels we render. Each tier caps the device-pixel-ratio:
// lower renders fewer pixels (faster, softer), higher renders sharper on hi-dpi displays.
export type RenderScale = "performance" | "balanced" | "quality" | "ultra";
export const RENDER_SCALES: readonly RenderScale[] = ["performance", "balanced", "quality", "ultra"];
export const RENDER_SCALE_LABEL: Record<RenderScale, string> = { performance: "Performance", balanced: "Balanced", quality: "Quality", ultra: "Ultra" };
export const RENDER_SCALE_DPR: Record<RenderScale, number> = { performance: 0.62, balanced: 1, quality: 1.5, ultra: 2 };

// Rebindable battle keys (KeyboardEvent.code values). Camera (WASD/arrows), digits,
// Escape, and R stay fixed.
export type BindableAction =
  | "endTurn" | "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "overwatch" | "crouch" | "log" | "confirm" | "cycle";
export const DEFAULT_KEYBINDS: Record<BindableAction, string> = {
  endTurn: "Space",
  move: "KeyM",
  shoot: "KeyF",
  grenade: "KeyG",
  ram: "KeyX",
  defend: "KeyV",
  melee: "KeyB",
  overwatch: "KeyO",
  crouch: "KeyC",
  log: "KeyL",
  confirm: "Enter",
  cycle: "Tab",
};
export const KEYBIND_LABELS: Record<BindableAction, string> = {
  endTurn: "End turn",
  move: "Move order",
  shoot: "Shoot order",
  grenade: "Grenade order",
  ram: "Ram order",
  defend: "Crouch panel",
  melee: "Strike order",
  overwatch: "Overwatch panel",
  crouch: "Quick crouch",
  log: "Toggle log",
  confirm: "Confirm action",
  cycle: "Cycle units",
};
export function keyDisplay(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export class GameSettings {
  muted = false;
  volume = 0.6;
  musicVolume = 0.5;
  difficulty: Difficulty = "normal";
  reducedMotion = false;
  actionPace: ActionPace = "normal";
  renderScale: RenderScale = "quality";
  // High-contrast team palette (blue vs orange) for colorblind players.
  highContrastTeams = false;
  // Cosmetic vehicle skin pack ("" = standard, "winter" = arctic camo retextures).
  unitSkin = "";
  keybinds: Record<BindableAction, string> = { ...DEFAULT_KEYBINDS };
  // Debug/sandbox cheats — only shown + applied when the game is launched with the ?debug flag
  // (see the Debug section in Settings / the README). Persisted like any other setting.
  debugInfiniteMoney = false;
  debugFreeCooldown = false;

  constructor() {
    this.load();
  }

  // The dt multiplier applied to the sim while resolving orders.
  get resolveSpeed(): number {
    return PACE_SPEED[this.actionPace];
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<GameSettings>;
      if (typeof s.muted === "boolean") this.muted = s.muted;
      if (typeof s.volume === "number") this.volume = Math.max(0, Math.min(1, s.volume));
      if (typeof s.musicVolume === "number") this.musicVolume = Math.max(0, Math.min(1, s.musicVolume));
      if (s.difficulty === "easy" || s.difficulty === "normal" || s.difficulty === "hard") this.difficulty = s.difficulty;
      if (typeof s.reducedMotion === "boolean") this.reducedMotion = s.reducedMotion;
      if (s.actionPace === "slow" || s.actionPace === "normal" || s.actionPace === "fast") this.actionPace = s.actionPace;
      if (s.renderScale && RENDER_SCALES.includes(s.renderScale)) this.renderScale = s.renderScale;
      if (typeof s.highContrastTeams === "boolean") this.highContrastTeams = s.highContrastTeams;
      if (typeof s.unitSkin === "string") this.unitSkin = s.unitSkin;
      if (s.keybinds && typeof s.keybinds === "object") this.keybinds = { ...DEFAULT_KEYBINDS, ...s.keybinds };
      if (typeof s.debugInfiniteMoney === "boolean") this.debugInfiniteMoney = s.debugInfiniteMoney;
      if (typeof s.debugFreeCooldown === "boolean") this.debugFreeCooldown = s.debugFreeCooldown;
    } catch {
      // ignore
    }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ muted: this.muted, volume: this.volume, musicVolume: this.musicVolume, difficulty: this.difficulty, reducedMotion: this.reducedMotion, actionPace: this.actionPace, renderScale: this.renderScale, highContrastTeams: this.highContrastTeams, unitSkin: this.unitSkin, keybinds: this.keybinds, debugInfiniteMoney: this.debugInfiniteMoney, debugFreeCooldown: this.debugFreeCooldown }));
    } catch {
      // ignore
    }
  }
}

export const settings = new GameSettings();
