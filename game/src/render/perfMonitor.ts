// ============================================================================
//  PerfMonitor — rolling frame-time + render-cost instrumentation.
// ----------------------------------------------------------------------------
//  Fed one `frameMs` sample per rendered frame plus the renderer's draw-call
//  stats, it answers "is the game fast, and is it getting slower?" with hard
//  numbers: FPS, frame-time percentiles (p50/p95/p99/max), jank counts, and the
//  GPU work per frame (draw calls, triangles, live geometries/textures).
//
//  It is the data source behind window.__rht.perf() and the perf-bench harness.
//  The percentile/aggregate math is pure (`summarizeFrames`) so it is unit
//  tested without a browser.
// ============================================================================

export interface RenderInfo {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
}

export interface FrameStats {
  /** Frames sampled in the current window. */
  count: number;
  /** Mean frame time in milliseconds. */
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  /** Worst single frame in the window — the spike that hurts most. */
  max: number;
  /** Frames slower than the jank threshold (default 1/30s). */
  jank: number;
  /** jank / count, 0..1 — the fraction of frames that stuttered. */
  jankRatio: number;
}

export interface PerfSnapshot {
  /** Average frames-per-second over the window (1000 / mean frame time). */
  fps: number;
  /** Wall-clock span the window covers, in ms. */
  windowMs: number;
  frame: FrameStats;
  /** Last-frame GPU cost from THREE.WebGLRenderer.info, or null if not fed. */
  render: RenderInfo | null;
  /** Total live scene objects (leak signal), or null if not fed. */
  sceneObjects: number | null;
}

/** Pure: derive frame-time percentiles + jank from a list of per-frame millisecond samples. */
export function summarizeFrames(samples: readonly number[], jankMs = 1000 / 30): FrameStats {
  const count = samples.length;
  if (count === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, jank: 0, jankRatio: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  let jank = 0;
  for (const s of samples) {
    sum += s;
    if (s > jankMs) jank += 1;
  }
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return {
    count,
    mean: round2(sum / count),
    p50: round2(pct(50)),
    p95: round2(pct(95)),
    p99: round2(pct(99)),
    max: round2(sorted[sorted.length - 1]),
    jank,
    jankRatio: round3(jank / count),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export class PerfMonitor {
  private readonly capacity: number;
  private readonly buffer: Float64Array;
  private head = 0;
  private filled = 0;
  private windowStart = 0;
  private windowSpan = 0;
  private lastRender: RenderInfo | null = null;
  private sceneObjects: number | null = null;
  private readonly jankMs: number;

  /** @param capacity max frames retained for the rolling window (~600 ≈ 10s at 60fps). */
  constructor(capacity = 600, jankMs = 1000 / 30) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Float64Array(this.capacity);
    this.jankMs = jankMs;
  }

  /** Record one rendered frame. `nowMs` lets the window track real elapsed time. */
  sample(frameMs: number, nowMs = 0): void {
    if (!Number.isFinite(frameMs) || frameMs < 0) return;
    if (this.filled === 0) this.windowStart = nowMs;
    this.buffer[this.head] = frameMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
    this.windowSpan = Math.max(0, nowMs - this.windowStart);
  }

  /** Stash the latest renderer draw stats + scene object count for the next snapshot. */
  setRenderInfo(info: RenderInfo | null, sceneObjects: number | null = null): void {
    this.lastRender = info;
    this.sceneObjects = sceneObjects;
  }

  /** Discard the current window and start a fresh measurement. */
  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.windowStart = 0;
    this.windowSpan = 0;
  }

  private currentSamples(): number[] {
    const out: number[] = [];
    const start = this.filled < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.filled; i += 1) {
      out.push(this.buffer[(start + i) % this.capacity]);
    }
    return out;
  }

  snapshot(): PerfSnapshot {
    const frame = summarizeFrames(this.currentSamples(), this.jankMs);
    return {
      fps: frame.mean > 0 ? round2(1000 / frame.mean) : 0,
      windowMs: round2(this.windowSpan),
      frame,
      render: this.lastRender,
      sceneObjects: this.sceneObjects,
    };
  }
}
