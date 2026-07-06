import { beforeEach, describe, expect, it } from "vitest";
import { battleReward, Progression } from "./progression";

function fakeStorage(): void {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

describe("Progression", () => {
  beforeEach(fakeStorage);

  it("starts with the free defaults unlocked and equipped", () => {
    const p = new Progression();
    expect(p.points).toBe(0);
    expect(p.isUnlocked("default")).toBe(true);
    expect(p.equipped("accent")).toBe("default");
    expect(p.equipped("title")).toBe("rookie");
    expect(p.equipped("emblem")).toBe("none");
  });

  it("awards points, flooring negatives and rounding fractions", () => {
    const p = new Progression();
    p.award(50);
    p.award(-999); // clamped to 0
    p.award(10.6); // rounds to 11
    expect(p.points).toBe(61);
  });

  it("unlocks only owned-not / affordable cosmetics and spends the cost", () => {
    const p = new Progression();
    expect(p.unlock("ember")).toBe(false); // costs 60, broke
    p.award(60);
    expect(p.unlock("ember")).toBe(true);
    expect(p.points).toBe(0);
    expect(p.isUnlocked("ember")).toBe(true);
    expect(p.unlock("ember")).toBe(false); // already owned
    expect(p.unlock("default")).toBe(false); // free but already owned
  });

  it("equips only owned cosmetics and reflects them in the accessors", () => {
    const p = new Progression();
    expect(p.setEquipped("ember")).toBe(false); // not owned
    p.award(500);
    p.unlock("ember");
    p.unlock("vanguard");
    p.unlock("skull");
    expect(p.setEquipped("ember")).toBe(true);
    expect(p.setEquipped("vanguard")).toBe(true);
    expect(p.setEquipped("skull")).toBe(true);
    expect(p.accentColor()).toBe(0xff9d5c);
    expect(p.titleText()).toBe("Vanguard Actual");
    expect(p.emblemGlyph()).toBe("☠");
    expect(p.isEquipped("ember")).toBe(true);
    expect(p.isEquipped("default")).toBe(false);
  });

  it("persists points, unlocks, and equipped slots across instances", () => {
    const p = new Progression();
    p.award(200);
    p.unlock("viper");
    p.setEquipped("viper");
    const reloaded = new Progression();
    expect(reloaded.points).toBe(200 - 90);
    expect(reloaded.isUnlocked("viper")).toBe(true);
    expect(reloaded.equipped("accent")).toBe("viper");
  });
});

describe("battleReward", () => {
  it("pays more for wins, scales with difficulty, and rewards decisive speed", () => {
    expect(battleReward(true, "normal", 10)).toBe(104); // 70*1.2 + (30-10)
    expect(battleReward(false, "easy", 20)).toBe(25); // loss: 25*1 + no speed bonus
    expect(battleReward(true, "hard", 3)).toBe(139); // 70*1.6 + (30-3)
    // A faster win always beats a slower one; losses never get the speed bonus.
    expect(battleReward(true, "normal", 5)).toBeGreaterThan(battleReward(true, "normal", 25));
    expect(battleReward(false, "hard", 1)).toBe(40); // 25*1.6, no speed
  });
});
