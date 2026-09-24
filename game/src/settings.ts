// Persisted player settings: audio mute/volume, default bot difficulty, reduced motion.

import type { Difficulty } from "./game/sim";
import { DEFAULT_FACTION, FACTIONS, type FactionId } from "./game/factions";

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
  | "endTurn" | "move" | "shoot" | "grenade" | "ram" | "defend" | "melee" | "crouch" | "log" | "confirm" | "cycle";
export const DEFAULT_KEYBINDS: Record<BindableAction, string> = {
  endTurn: "Space",
  move: "KeyM",
  shoot: "KeyF",
  grenade: "KeyG",
  ram: "KeyX",
  defend: "KeyV",
  melee: "KeyB",
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
  // Last faction the player deployed with, remembered like difficulty so the setup screen opens
  // on their preference instead of resetting to the default every time.
  faction: FactionId = DEFAULT_FACTION;
  reducedMotion = false;
  actionPace: ActionPace = "normal";
  renderScale: RenderScale = "quality";
  // High-contrast team palette (blue vs orange) for colorblind players.
  highContrastTeams = false;
  /** Ask before ending a turn with units that still have action points (Gameplay tab; the prompt's
   *  "don't show again" box turns it off). */
  warnUnusedAp = true;
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
      // Validated against the live faction list rather than trusted: a save written before a
      // faction was renamed or removed must not leave the game holding an id nothing resolves to.
      if (typeof s.faction === "string" && FACTIONS.some((f) => f.id === s.faction)) this.faction = s.faction as FactionId;
      if (typeof s.reducedMotion === "boolean") this.reducedMotion = s.reducedMotion;
      if (s.actionPace === "slow" || s.actionPace === "normal" || s.actionPace === "fast") this.actionPace = s.actionPace;
      if (s.renderScale && RENDER_SCALES.includes(s.renderScale)) this.renderScale = s.renderScale;
      if (typeof s.highContrastTeams === "boolean") this.highContrastTeams = s.highContrastTeams;
      if (typeof s.warnUnusedAp === "boolean") this.warnUnusedAp = s.warnUnusedAp;
      if (s.keybinds && typeof s.keybinds === "object") {
        // Only known actions survive a load: a removed action (Overwatch) must not linger as a dead rebind row.
        const saved = s.keybinds as Record<string, unknown>;
        for (const action of Object.keys(DEFAULT_KEYBINDS) as BindableAction[]) {
          if (typeof saved[action] === "string") this.keybinds[action] = saved[action] as string;
        }
      }
      if (typeof s.debugInfiniteMoney === "boolean") this.debugInfiniteMoney = s.debugInfiniteMoney;
      if (typeof s.debugFreeCooldown === "boolean") this.debugFreeCooldown = s.debugFreeCooldown;
    } catch {
      // ignore
    }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ muted: this.muted, volume: this.volume, musicVolume: this.musicVolume, difficulty: this.difficulty, faction: this.faction, reducedMotion: this.reducedMotion, actionPace: this.actionPace, renderScale: this.renderScale, highContrastTeams: this.highContrastTeams, warnUnusedAp: this.warnUnusedAp, keybinds: this.keybinds, debugInfiniteMoney: this.debugInfiniteMoney, debugFreeCooldown: this.debugFreeCooldown }));
    } catch {
      // ignore
    }
  }
}

export const settings = new GameSettings();
