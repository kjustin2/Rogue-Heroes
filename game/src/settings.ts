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

export class GameSettings {
  muted = false;
  volume = 0.6;
  musicVolume = 0.5;
  difficulty: Difficulty = "normal";
  reducedMotion = false;
  actionPace: ActionPace = "normal";
  renderScale: RenderScale = "quality";

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
    } catch {
      // ignore
    }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ muted: this.muted, volume: this.volume, musicVolume: this.musicVolume, difficulty: this.difficulty, reducedMotion: this.reducedMotion, actionPace: this.actionPace, renderScale: this.renderScale }));
    } catch {
      // ignore
    }
  }
}

export const settings = new GameSettings();
