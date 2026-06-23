// Player progression: points earned by playing battles, spent to unlock cosmetic accent
// colors for your units. Persisted in localStorage. Purely cosmetic — no gameplay effect.

export interface Cosmetic {
  id: string;
  name: string;
  cost: number;
  accent: number; // hex color
  desc: string;
}

export const COSMETICS: readonly Cosmetic[] = [
  { id: "default", name: "Standard Cyan", cost: 0, accent: 0x9dfcff, desc: "Default issue command markings." },
  { id: "ember", name: "Ember Orange", cost: 60, accent: 0xff9d5c, desc: "Warm furnace livery." },
  { id: "viper", name: "Viper Green", cost: 90, accent: 0x9dff7a, desc: "Recon scout colours." },
  { id: "ice", name: "Glacier Blue", cost: 120, accent: 0x8fe9ff, desc: "Frostline detachment." },
  { id: "royal", name: "Royal Violet", cost: 150, accent: 0xc08cff, desc: "Honour-guard trim." },
  { id: "crimson", name: "Crimson Edge", cost: 190, accent: 0xff6b7a, desc: "Veterans of the red line." },
  { id: "gold", name: "Gilded Gold", cost: 260, accent: 0xffd166, desc: "Elite campaign honours." },
];

const KEY = "rht.progression.v1";

export class Progression {
  points = 0;
  unlocked = new Set<string>(["default"]);
  accentId = "default";

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as { points?: number; unlocked?: string[]; accent?: string };
      this.points = Math.max(0, Math.round(state.points ?? 0));
      this.unlocked = new Set(state.unlocked ?? ["default"]);
      this.unlocked.add("default");
      this.accentId = state.accent && this.unlocked.has(state.accent) ? state.accent : "default";
    } catch {
      // ignore corrupt/unavailable storage
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ points: this.points, unlocked: [...this.unlocked], accent: this.accentId }));
    } catch {
      // ignore
    }
  }

  award(points: number): void {
    this.points += Math.max(0, Math.round(points));
    this.save();
  }

  cosmetic(id: string): Cosmetic {
    return COSMETICS.find((c) => c.id === id) ?? COSMETICS[0];
  }

  isUnlocked(id: string): boolean {
    return this.unlocked.has(id);
  }

  // Spend points to unlock a cosmetic. Returns false if already owned or unaffordable.
  unlock(id: string): boolean {
    if (this.isUnlocked(id)) return false;
    const cosmetic = this.cosmetic(id);
    if (this.points < cosmetic.cost) return false;
    this.points -= cosmetic.cost;
    this.unlocked.add(id);
    this.save();
    return true;
  }

  setAccent(id: string): boolean {
    if (!this.isUnlocked(id)) return false;
    this.accentId = id;
    this.save();
    return true;
  }

  accentColor(): number {
    return this.cosmetic(this.accentId).accent;
  }
}

export const progression = new Progression();

// Points awarded for finishing a battle, scaled by outcome and difficulty.
export function battleReward(victory: boolean, difficulty: "easy" | "normal" | "hard", turns: number): number {
  const base = victory ? 70 : 25;
  const diff = difficulty === "hard" ? 1.6 : difficulty === "normal" ? 1.2 : 1;
  const speed = victory ? Math.max(0, 30 - turns) : 0; // reward decisive wins
  return Math.round(base * diff + speed);
}
