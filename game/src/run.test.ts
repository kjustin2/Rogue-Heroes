import { beforeEach, describe, expect, it } from "vitest";
import { RUN_LENGTH, SkirmishRun } from "./run";

// Minimal in-memory localStorage so persistence round-trips can be asserted (node env has none).
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

describe("SkirmishRun", () => {
  beforeEach(fakeStorage);

  it("plans a fixed-length ladder deterministically from the seed", () => {
    const a = new SkirmishRun();
    const b = new SkirmishRun();
    a.begin(0xc0ffee);
    b.begin(0xc0ffee);
    expect(a.plan()).toHaveLength(RUN_LENGTH);
    expect(a.plan()).toEqual(b.plan()); // same seed reproduces the whole run (needed for resume)
    // A second call on the same instance is also stable.
    expect(a.plan()).toEqual(a.plan());
  });

  it("never repeats a map back-to-back and ramps difficulty easy -> hard", () => {
    const r = new SkirmishRun();
    r.begin(42);
    const plan = r.plan();
    for (let i = 1; i < plan.length; i += 1) expect(plan[i].map).not.toBe(plan[i - 1].map);
    expect(plan[0].difficulty).toBe("easy");
    expect(plan[RUN_LENGTH - 1].difficulty).toBe("hard");
  });

  it("tracks the current sector and 1-based number", () => {
    const r = new SkirmishRun();
    r.begin(7);
    expect(r.index).toBe(0);
    expect(r.sectorNumber).toBe(1);
    expect(r.current()).toEqual(r.plan()[0]);
  });

  it("carries survivors forward (permadeath), banks capped cash, and advances", () => {
    const r = new SkirmishRun();
    r.begin(1);
    const done = r.advance([
      { name: "A", kind: "soldier", kills: 2 },
      { name: "B", kind: "tank", kills: 1 },
    ], 500);
    expect(done).toBe(false);
    expect(r.index).toBe(1);
    expect(r.roster.map((m) => m.name).sort()).toEqual(["A", "B"]);
    expect(r.bankedCash).toBe(300); // capped from 500
    expect(r.consumeCash()).toBe(300);
    expect(r.consumeCash()).toBe(0); // cleared after taking

    // B fell (absent from survivors) — dropped. Cash floored/capped from a fractional value.
    r.advance([{ name: "A", kind: "soldier", kills: 3 }], 40.9);
    expect(r.roster.map((m) => m.name)).toEqual(["A"]);
    expect(r.bankedCash).toBe(40);
    expect(r.index).toBe(2);
  });

  it("clamps negative leftover cash to zero", () => {
    const r = new SkirmishRun();
    r.begin(1);
    r.advance([], -50);
    expect(r.bankedCash).toBe(0);
  });

  it("completes the run on the final sector and clears active", () => {
    const r = new SkirmishRun();
    r.begin(1);
    let done = false;
    for (let i = 0; i < RUN_LENGTH; i += 1) done = r.advance([], 0);
    expect(done).toBe(true); // the RUN_LENGTH-th advance is the finale
    expect(r.active).toBe(false);
  });

  it("end() abandons a run and drops banked cash", () => {
    const r = new SkirmishRun();
    r.begin(1);
    r.advance([], 200);
    r.end();
    expect(r.active).toBe(false);
    expect(r.bankedCash).toBe(0);
  });

  it("persists across instances via localStorage", () => {
    const r = new SkirmishRun();
    r.begin(0xabc);
    r.advance([{ name: "Vet", kind: "striker", kills: 4 }], 120);
    const reloaded = new SkirmishRun();
    expect(reloaded.seed).toBe(r.seed);
    expect(reloaded.index).toBe(1);
    expect(reloaded.active).toBe(true);
    expect(reloaded.roster.map((m) => m.name)).toEqual(["Vet"]);
    expect(reloaded.plan()).toEqual(r.plan()); // same seed -> same ladder after reload
  });
});
