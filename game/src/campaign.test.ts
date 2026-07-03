import { describe, expect, it } from "vitest";
import { Campaign, CAMPAIGN, rankFor, rankHpBonus } from "./campaign";

describe("campaign progression", () => {
  it("branch missions unlock from either fork and converge", () => {
    const c = new Campaign();
    c.reset();
    const m5 = CAMPAIGN.findIndex((m) => m.id === "m5-buried-kings");
    const m5b = CAMPAIGN.findIndex((m) => m.id === "m5b-sever-the-line");
    const m6 = CAMPAIGN.findIndex((m) => m.id === "m6-no-mans-basin");
    expect(c.isUnlocked(m5)).toBe(false);
    expect(c.isUnlocked(m5b)).toBe(false);
    c.markComplete("m4-signal-theft");
    expect(c.isUnlocked(m5)).toBe(true); // both forks open
    expect(c.isUnlocked(m5b)).toBe(true);
    expect(c.isUnlocked(m6)).toBe(false);
    c.markComplete("m5b-sever-the-line"); // either fork alone opens the convergence
    expect(c.isUnlocked(m6)).toBe(true);
  });

  it("roster merges survivors, drops the fallen, and ranks up on kills", () => {
    const c = new Campaign();
    c.reset();
    c.recordBattleOutcome([
      { name: "Recruit 1", kind: "soldier", kills: 2 },
      { name: "Tank 3", kind: "tank", kills: 1 },
    ]);
    expect(c.roster.length).toBe(2);
    // Recruit 1 survives again with 3 more kills; Tank 3 fell (absent from survivors).
    c.recordBattleOutcome([{ name: "Recruit 1", kind: "soldier", kills: 3 }]);
    expect(c.roster.length).toBe(1);
    expect(c.roster[0]).toMatchObject({ name: "Recruit 1", kills: 5, missions: 2 });
    expect(rankFor(c.roster[0].kills)).toBe("Elite");
    expect(rankHpBonus("Elite")).toBeGreaterThan(rankHpBonus("Veteran"));
  });

  it("locks each mission until the previous one is cleared", () => {
    const c = new Campaign();
    c.reset();
    expect(c.isUnlocked(0)).toBe(true);
    expect(c.isUnlocked(1)).toBe(false);
    c.markComplete(CAMPAIGN[0].id);
    expect(c.isCompleted(CAMPAIGN[0].id)).toBe(true);
    expect(c.isUnlocked(1)).toBe(true);
    expect(c.isUnlocked(2)).toBe(false);
  });

  it("tracks the next incomplete mission and full completion", () => {
    const c = new Campaign();
    c.reset();
    expect(c.firstIncompleteIndex()).toBe(0);
    expect(c.nextMission(CAMPAIGN[0].id)?.id).toBe(CAMPAIGN[1].id);
    for (const m of CAMPAIGN) c.markComplete(m.id);
    expect(c.isAllComplete()).toBe(true);
    expect(c.nextMission(CAMPAIGN[CAMPAIGN.length - 1].id)).toBeUndefined();
  });

  it("remembers and clears the active-mission save tag", () => {
    const c = new Campaign();
    c.reset();
    c.setActive(CAMPAIGN[2].id);
    expect(c.activeMissionId).toBe(CAMPAIGN[2].id);
    c.markComplete(CAMPAIGN[2].id); // completing clears the in-progress tag
    expect(c.activeMissionId).toBeUndefined();
  });
});
