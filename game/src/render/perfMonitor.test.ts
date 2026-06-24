import { describe, it, expect } from "vitest";
import { PerfMonitor, summarizeFrames } from "./perfMonitor";

describe("summarizeFrames", () => {
  it("returns zeros for an empty window", () => {
    const s = summarizeFrames([]);
    expect(s).toEqual({ count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, jank: 0, jankRatio: 0 });
  });

  it("computes mean, percentiles and max", () => {
    const frames = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 ms
    const s = summarizeFrames(frames);
    expect(s.count).toBe(100);
    expect(s.mean).toBeCloseTo(50.5, 1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });

  it("counts jank frames above the threshold", () => {
    // 8 fast frames (16ms) + 2 slow frames (40ms) -> 2 jank against the 33.3ms default.
    const frames = [16, 16, 16, 16, 16, 16, 16, 16, 40, 40];
    const s = summarizeFrames(frames);
    expect(s.jank).toBe(2);
    expect(s.jankRatio).toBeCloseTo(0.2, 5);
  });
});

describe("PerfMonitor", () => {
  it("derives fps from mean frame time", () => {
    const m = new PerfMonitor();
    for (let i = 0; i < 60; i += 1) m.sample(16.67, i * 16.67);
    const snap = m.snapshot();
    expect(snap.fps).toBeGreaterThan(58);
    expect(snap.fps).toBeLessThan(62);
    expect(snap.frame.count).toBe(60);
  });

  it("ignores non-finite / negative samples", () => {
    const m = new PerfMonitor();
    m.sample(NaN);
    m.sample(-5);
    m.sample(Infinity);
    expect(m.snapshot().frame.count).toBe(0);
  });

  it("keeps only the most recent `capacity` frames", () => {
    const m = new PerfMonitor(10);
    for (let i = 0; i < 25; i += 1) m.sample(10 + i, i);
    const snap = m.snapshot();
    expect(snap.frame.count).toBe(10);
    // The window should reflect the last 10 samples (25..34 ms), so mean ~29.5.
    expect(snap.frame.mean).toBeGreaterThan(28);
    expect(snap.frame.max).toBe(34);
  });

  it("reset clears the window", () => {
    const m = new PerfMonitor();
    m.sample(16, 0);
    m.reset();
    expect(m.snapshot().frame.count).toBe(0);
  });

  it("surfaces fed render info + scene object count", () => {
    const m = new PerfMonitor();
    m.sample(16, 0);
    m.setRenderInfo({ calls: 120, triangles: 50000, geometries: 80, textures: 12, programs: 9 }, 340);
    const snap = m.snapshot();
    expect(snap.render?.calls).toBe(120);
    expect(snap.sceneObjects).toBe(340);
  });
});
