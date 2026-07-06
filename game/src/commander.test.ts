import { beforeEach, describe, expect, it } from "vitest";
import { Commander } from "./commander";

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

describe("Commander", () => {
  beforeEach(fakeStorage);

  it("advances doctrine mastery at 3 / 6 / 10 lifetime researches", () => {
    const c = new Commander();
    c.reset();
    expect(c.masteryTier("assault")).toBe(0);
    for (let i = 0; i < 3; i += 1) c.recordResearch("assault");
    expect(c.masteryTier("assault")).toBe(1);
    for (let i = 0; i < 3; i += 1) c.recordResearch("assault"); // 6 total
    expect(c.masteryTier("assault")).toBe(2);
    for (let i = 0; i < 4; i += 1) c.recordResearch("assault"); // 10 total
    expect(c.masteryTier("assault")).toBe(3);
  });

  it("sums total mastery across doctrines", () => {
    const c = new Commander();
    c.reset();
    for (let i = 0; i < 6; i += 1) c.recordResearch("assault"); // tier 2
    for (let i = 0; i < 3; i += 1) c.recordResearch("recon"); // tier 1
    expect(c.totalMastery()).toBe(3);
  });

  it("tallies battles, wins/losses, and lifetime kills by kind", () => {
    const c = new Commander();
    c.reset();
    c.recordBattle({ victory: true, turns: 8, losses: 1, killsByKind: { soldier: 2, tank: 1 }, toppleHappened: false });
    c.recordBattle({ victory: false, turns: 12, losses: 3, killsByKind: { soldier: 1 }, toppleHappened: false });
    expect(c.stats.battles).toBe(2);
    expect(c.stats.wins).toBe(1);
    expect(c.stats.losses).toBe(1);
    expect(c.stats.kills).toBe(4);
    expect(c.stats.killsByKind.soldier).toBe(3);
    expect(c.topUnitKind()).toBe("soldier");
  });

  it("awards each medal once, only when its condition is met", () => {
    const c = new Commander();
    c.reset();
    // Flawless blitz win with a topple -> first-victory + flawless + blitz + demolitionist at once.
    const first = c.recordBattle({ victory: true, turns: 4, losses: 0, killsByKind: { soldier: 1 }, toppleHappened: true }).map((m) => m.id);
    expect(first.sort()).toEqual(["blitz", "demolitionist", "first-victory", "flawless"]);
    // A second identical win re-earns nothing (already held).
    const again = c.recordBattle({ victory: true, turns: 4, losses: 0, killsByKind: {}, toppleHappened: true });
    expect(again).toEqual([]);
  });

  it("earns Warlord at 10 wins and Centurion at 100 kills", () => {
    const c = new Commander();
    c.reset();
    let warlord = false;
    for (let w = 0; w < 10; w += 1) {
      const fresh = c.recordBattle({ victory: true, turns: 20, losses: 1, killsByKind: { soldier: 12 }, toppleHappened: false });
      if (fresh.some((m) => m.id === "warlord")) warlord = true;
    }
    expect(warlord).toBe(true);
    expect(c.stats.medals).toContain("centurion"); // 10 * 12 = 120 kills crossed 100
  });

  it("persists stats across instances", () => {
    const c = new Commander();
    c.reset();
    c.recordResearch("armor");
    c.recordBattle({ victory: true, turns: 6, losses: 0, killsByKind: { apc: 3 }, toppleHappened: false });
    const reloaded = new Commander();
    expect(reloaded.stats.wins).toBe(1);
    expect(reloaded.stats.killsByKind.apc).toBe(3);
    expect(reloaded.stats.doctrineUse.armor).toBe(1);
    expect(reloaded.stats.medals).toContain("first-victory");
  });
});
