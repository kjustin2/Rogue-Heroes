import { describe, it, expect } from "vitest";
import { runDiagnostics, describeScene, type DiagSim, type DiagEntity, type Bounds } from "./diagnostics";

const BOUNDS: Bounds = { minX: -20, maxX: 20, minZ: -12, maxZ: 12 };

function entity(over: Partial<DiagEntity> = {}): DiagEntity {
  return {
    id: "e1",
    kind: "soldier",
    team: "player",
    position: { x: 0, z: 0 },
    radius: 0.6,
    height: 1,
    status: { alive: true },
    parts: [{ hp: 40, maxHp: 40 }],
    ...over,
  };
}

function sim(over: Partial<DiagSim> = {}): DiagSim {
  return {
    phase: "command",
    turn: 1,
    mode: "destroy",
    selectedId: undefined,
    entities: [],
    projectiles: [],
    effects: [],
    ...over,
  };
}

describe("runDiagnostics", () => {
  it("passes a clean field", () => {
    const r = runDiagnostics(sim({ entities: [entity()] }), { bounds: BOUNDS });
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(0);
  });

  it("flags a non-finite position as an error", () => {
    const r = runDiagnostics(sim({ entities: [entity({ position: { x: NaN, z: 0 } })] }), { bounds: BOUNDS });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "nan-position")).toBe(true);
  });

  it("warns when a live unit is outside the arena", () => {
    const r = runDiagnostics(sim({ entities: [entity({ position: { x: 99, z: 0 } })] }), { bounds: BOUNDS });
    expect(r.issues.some((i) => i.code === "out-of-bounds")).toBe(true);
  });

  it("warns on stacked (overlapping) units", () => {
    const a = entity({ id: "a", position: { x: 0, z: 0 } });
    const b = entity({ id: "b", position: { x: 0.1, z: 0 } });
    const r = runDiagnostics(sim({ entities: [a, b] }), { bounds: BOUNDS });
    expect(r.issues.some((i) => i.code === "overlap")).toBe(true);
  });

  it("errors on an empty in-battle field", () => {
    const r = runDiagnostics(sim({ phase: "resolve", entities: [] }), { bounds: BOUNDS });
    expect(r.issues.some((i) => i.code === "empty-field")).toBe(true);
  });

  it("warns when the selected unit projects off-screen", () => {
    const sel = entity({ id: "sel" });
    const r = runDiagnostics(sim({ entities: [sel], selectedId: "sel" }), {
      bounds: BOUNDS,
      project: () => ({ x: -50, y: -50, visible: false, behind: false }),
    });
    expect(r.issues.some((i) => i.code === "selected-offscreen")).toBe(true);
  });

  it("flags a draw-call spike from perf", () => {
    const r = runDiagnostics(sim({ entities: [entity()] }), {
      bounds: BOUNDS,
      perf: { fps: 60, render: { calls: 5000, triangles: 1 }, frame: { jankRatio: 0, max: 16 } },
      drawCallBudget: 1200,
    });
    expect(r.issues.some((i) => i.code === "draw-call-spike")).toBe(true);
  });

  it("flags low fps from perf", () => {
    const r = runDiagnostics(sim({ entities: [entity()] }), {
      bounds: BOUNDS,
      perf: { fps: 12, render: { calls: 50, triangles: 1 }, frame: { jankRatio: 0.5, max: 90 } },
      fpsFloor: 30,
    });
    expect(r.issues.some((i) => i.code === "low-fps")).toBe(true);
  });
});

describe("describeScene", () => {
  it("counts teams and summarizes", () => {
    const d = describeScene(sim({
      entities: [entity({ id: "p1", team: "player" }), entity({ id: "e1", team: "enemy" })],
    }));
    expect(d.counts.player).toBe(1);
    expect(d.counts.enemy).toBe(1);
    expect(d.summary).toContain("Turn 1");
  });

  it("computes hp percentage and projects screen coords", () => {
    const d = describeScene(
      sim({ entities: [entity({ id: "p1", parts: [{ hp: 20, maxHp: 40 }] })], selectedId: "p1" }),
      { project: () => ({ x: 800.6, y: 450.2, visible: true, behind: false }), selectedId: "p1" },
    );
    const e = d.entities[0];
    expect(e.hpPct).toBe(50);
    expect(e.screen).toEqual({ x: 801, y: 450, visible: true });
    expect(e.selected).toBe(true);
  });
});
