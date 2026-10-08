import { beforeEach, describe, expect, it } from "vitest";
import { Commander, MEDALS, MEDAL_PAGES } from "./commander";
import { FACTIONS } from "./game/factions";
import { SUPPORT_POWERS, TROOP_KINDS } from "./game/units";
import { MAPS } from "./game/maps";
import { TECH_TREE } from "./game/tech";
import { PLAYABLE_MODES } from "./game/modes";

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

  it("tracks distinct map/mode/faction wins and the context medals", () => {
    const c = new Commander();
    c.reset();
    const base = { turns: 9, losses: 1, killsByKind: {}, toppleHappened: false };
    const fresh = c.recordBattle({ ...base, victory: true, map: "verdant", mode: "ctf", faction: "bastion", difficulty: "hard", baseHealth: 0.2, arms: { infantry: true, vehicle: true, air: true } }).map((m) => m.id);
    expect(fresh).toEqual(expect.arrayContaining(["iron", "clutch", "combined-arms"]));
    c.recordBattle({ ...base, victory: false, map: "karak", mode: "hill" });
    c.recordBattle({ ...base, victory: true, map: "verdant", mode: "ctf" });
    expect(c.stats.mapWins).toEqual(["verdant"]); // a loss and a repeat add nothing
    expect(c.stats.modeWins).toEqual(["ctf"]);
    expect(c.stats.factionWins).toEqual(["bastion"]);
  });
});

describe("achievement pages (2026-10-02)", () => {
  it("every medal has a unique id on a real page, and a long perfect career earns all of them", () => {
    const ids = MEDALS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of MEDAL_PAGES) expect(MEDALS.filter((m) => m.page === page).length, page).toBeGreaterThanOrEqual(7);
    const c = new Commander();
    c.reset();
    for (let i = 0; i < 260; i += 1) {
      const map = MAPS[i % MAPS.length].id;
      const faction = FACTIONS[i % FACTIONS.length].id;
      c.recordBattle({
        victory: true, turns: 3, losses: 0, killsByKind: { soldier: 8, tank: 1, gunship: 1 }, toppleHappened: true,
        map, mode: PLAYABLE_MODES[i % PLAYABLE_MODES.length].id, faction, difficulty: "hard", baseHealth: 0.05,
        arms: { infantry: true, vehicle: true, air: true },
      });
    }
    for (let i = 0; i < 10; i += 1) for (const node of TECH_TREE) c.recordResearch(node.id);
    // The Arsenal page counts what the sim tallies; give it a long career of everything.
    const counters: Record<string, number> = {
      slams: 1000, thrown: 1000, ringouts: 10, burned: 1000, clashes: 100, cannon: 100, booms: 100, punches: 100, hooks: 100, bowled: 100, molotovs: 100, erupts: 100, slashed: 100, shoved: 100,
      fullcar: 1, hops: 1000, flung: 100, tankdrops: 10, supportCalls: 1000, "upgrade:cannon": 1,
      "killer:sledge": 100, "killer:bounty": 100, "killer:flamer": 100, "killer:rocketpost": 100,
    };
    for (const kind of TROOP_KINDS) counters[`deploy:${kind}`] = 1;
    for (const power of SUPPORT_POWERS) counters[`support:${power.kind}`] = 30;
    for (const node of TECH_TREE) counters[`research:${node.id}`] = 1;
    c.recordBattle({ victory: true, turns: 3, losses: 0, killsByKind: {}, toppleHappened: false, difficulty: "hard", baseHealth: 0.05, arms: { infantry: true, vehicle: true, air: true }, counters });
    const missing = ids.filter((id) => !c.stats.medals.includes(id));
    expect(missing).toEqual([]);
  });

  it("a loss breaks the win streak but keeps the best one", () => {
    const c = new Commander();
    c.reset();
    const win = { victory: true, turns: 9, losses: 2, killsByKind: {}, toppleHappened: false } as const;
    for (let i = 0; i < 4; i += 1) c.recordBattle(win);
    c.recordBattle({ ...win, victory: false });
    c.recordBattle(win);
    expect(c.stats.bestStreak).toBe(4);
    expect(c.stats.winStreak).toBe(1);
    expect(c.stats.medals).toContain("streak3");
  });
});

describe("achievement points and live unlocks (2026-10-03)", () => {
  it("every medal pays points, bigger goals pay more, and the Arsenal page is full", () => {
    for (const m of MEDALS) expect(m.points, m.id).toBeGreaterThan(0);
    const find = (id: string) => MEDALS.find((m) => m.id === id)!;
    expect(find("legend").points).toBeGreaterThan(find("warlord").points);
    expect(find("kills2500").points).toBeGreaterThan(find("kills25").points);
    expect(MEDALS.length).toBeGreaterThanOrEqual(80);
    expect(MEDALS.filter((m) => m.page === "Arsenal").length).toBeGreaterThanOrEqual(30);
  });

  it("a medal unlocks the moment its tally is met, mid-battle, and is not paid twice at the end", () => {
    const c = new Commander();
    c.reset();
    expect(c.liveCheck({ slams: 9 })).toHaveLength(0);
    const fresh = c.liveCheck({ slams: 10 });
    expect(fresh.map((m) => m.id)).toContain("slam10");
    expect(c.liveCheck({ slams: 10 }), "once only").toHaveLength(0);
    const end = c.recordBattle({ victory: true, turns: 9, losses: 1, killsByKind: {}, toppleHappened: false, counters: { slams: 10 } });
    expect(end.map((m) => m.id), "the end of the battle does not announce it again").not.toContain("slam10");
    expect(c.stats.counters.slams).toBe(10);
  });
});
