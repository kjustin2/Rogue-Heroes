// Player progression: points earned by playing battles, spent in the Armory to unlock cosmetics
// across three categories — unit accent colors, commander titles, and commander emblems. Persisted
// in localStorage. Purely cosmetic — no gameplay effect.

export type CosmeticKind = "accent" | "title" | "emblem";

export interface Cosmetic {
  id: string;
  kind: CosmeticKind;
  name: string;
  cost: number;
  desc: string;
  accent?: number; // hex color (accent kind)
  title?: string; // display callsign (title kind)
  emblem?: string; // glyph (emblem kind)
}

export const COSMETICS: readonly Cosmetic[] = [
  // ---- Unit accent colors ----
  { id: "default", kind: "accent", name: "Standard Cyan", cost: 0, accent: 0x9dfcff, desc: "Default issue command markings." },
  { id: "ember", kind: "accent", name: "Ember Orange", cost: 60, accent: 0xff9d5c, desc: "Warm furnace livery." },
  { id: "viper", kind: "accent", name: "Viper Green", cost: 90, accent: 0x9dff7a, desc: "Recon scout colours." },
  { id: "ice", kind: "accent", name: "Glacier Blue", cost: 120, accent: 0x8fe9ff, desc: "Frostline detachment." },
  { id: "royal", kind: "accent", name: "Royal Violet", cost: 150, accent: 0xc08cff, desc: "Honour-guard trim." },
  { id: "crimson", kind: "accent", name: "Crimson Edge", cost: 190, accent: 0xff6b7a, desc: "Veterans of the red line." },
  { id: "gold", kind: "accent", name: "Gilded Gold", cost: 260, accent: 0xffd166, desc: "Elite campaign honours." },
  { id: "abyss", kind: "accent", name: "Abyssal Teal", cost: 220, accent: 0x2fd4c0, desc: "Deep-strike raiders." },
  { id: "magma", kind: "accent", name: "Magma Red", cost: 240, accent: 0xff5230, desc: "Scorched-earth shock troops." },
  { id: "phantom", kind: "accent", name: "Phantom White", cost: 320, accent: 0xf0f6ff, desc: "Ghost company colours." },
  // ---- Commander titles (your callsign) ----
  { id: "rookie", kind: "title", name: "Recruit Commander", cost: 0, title: "Recruit Commander", desc: "Where everyone starts." },
  { id: "vanguard", kind: "title", name: "Vanguard Actual", cost: 80, title: "Vanguard Actual", desc: "The voice the Rogue Heroes answer to." },
  { id: "ironside", kind: "title", name: "Ironside", cost: 140, title: "Ironside", desc: "For those who never give ground." },
  { id: "warden", kind: "title", name: "Storm Warden", cost: 200, title: "Storm Warden", desc: "Master of the broken battlefield." },
  { id: "reaper", kind: "title", name: "The Reaper", cost: 280, title: "The Reaper", desc: "Earned in blood and dust." },
  { id: "legend", kind: "title", name: "Living Legend", cost: 420, title: "Living Legend", desc: "The commander who ended the war." },
  // ---- Commander emblems (a glyph beside your name) ----
  { id: "none", kind: "emblem", name: "No Emblem", cost: 0, emblem: "", desc: "Clean slate." },
  { id: "skull", kind: "emblem", name: "Death's Head", cost: 70, emblem: "☠", desc: "A warning to the Concord." },
  { id: "bolt", kind: "emblem", name: "Thunderbolt", cost: 110, emblem: "⚡", desc: "Strike fast, strike hard." },
  { id: "star", kind: "emblem", name: "Vanguard Star", cost: 160, emblem: "★", desc: "Mark of the lead company." },
  { id: "crown", kind: "emblem", name: "Iron Crown", cost: 240, emblem: "♛", desc: "Rule the ruins." },
];

export const COSMETIC_CATEGORIES: ReadonlyArray<{ kind: CosmeticKind; label: string }> = [
  { kind: "accent", label: "Unit Accents" },
  { kind: "title", label: "Commander Titles" },
  { kind: "emblem", label: "Emblems" },
];

const KEY = "rht.progression.v1";
const DEFAULTS: Record<CosmeticKind, string> = { accent: "default", title: "rookie", emblem: "none" };

export class Progression {
  points = 0;
  unlocked = new Set<string>(["default", "rookie", "none"]);
  private equip: Record<CosmeticKind, string> = { accent: "default", title: "rookie", emblem: "none" };

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as { points?: number; unlocked?: string[]; accent?: string; equip?: Partial<Record<CosmeticKind, string>> };
      this.points = Math.max(0, Math.round(state.points ?? 0));
      this.unlocked = new Set(state.unlocked ?? []);
      for (const id of ["default", "rookie", "none"]) this.unlocked.add(id);
      // Equip slots: prefer the new `equip` map, falling back to the legacy `accent` field.
      for (const kind of ["accent", "title", "emblem"] as CosmeticKind[]) {
        const want = state.equip?.[kind] ?? (kind === "accent" ? state.accent : undefined);
        this.equip[kind] = want && this.unlocked.has(want) ? want : DEFAULTS[kind];
      }
    } catch {
      // ignore corrupt/unavailable storage
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ points: this.points, unlocked: [...this.unlocked], accent: this.equip.accent, equip: this.equip }));
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

  equipped(kind: CosmeticKind): string {
    return this.equip[kind];
  }

  isEquipped(id: string): boolean {
    const c = this.cosmetic(id);
    return this.equip[c.kind] === id;
  }

  // Equip an owned cosmetic in its category. Returns false if not owned.
  setEquipped(id: string): boolean {
    const c = this.cosmetic(id);
    if (!this.isUnlocked(id)) return false;
    this.equip[c.kind] = id;
    this.save();
    return true;
  }

  accentColor(): number {
    return this.cosmetic(this.equip.accent).accent ?? 0x9dfcff;
  }

  titleText(): string {
    return this.cosmetic(this.equip.title).title ?? "Recruit Commander";
  }

  emblemGlyph(): string {
    return this.cosmetic(this.equip.emblem).emblem ?? "";
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
