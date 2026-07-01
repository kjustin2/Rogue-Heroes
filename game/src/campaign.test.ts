import { describe, expect, it } from "vitest";
import { Campaign, CAMPAIGN } from "./campaign";

describe("campaign progression", () => {
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
