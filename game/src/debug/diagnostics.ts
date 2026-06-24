// ============================================================================
//  Diagnostics + scene description — the "catch bugs" and "let the AI see the
//  scene" engine behind window.__rht.diagnostics() / describeScene().
// ----------------------------------------------------------------------------
//  diagnostics(): scans sim + render state for anomalies that a screenshot alone
//    is easy to miss — NaN positions, units stacked on top of each other, the
//    selected unit framed off-screen, stuck projectiles, draw-call/FPS spikes.
//    Returns a flat list of {severity, code, message} so the harness can fail a
//    run and a human/agent can read exactly what's wrong.
//
//  describeScene(): a structured, AI-friendly readout of every entity with its
//    world AND projected screen position, HP, and selection state, plus a
//    one-line text summary. This is what turns a raw screenshot into something
//    Claude can reason about ("the blob at (840,420) is heavy p-3 at 60/80 HP").
//
//  Both take structural inputs (not the concrete sim class) so they unit-test
//  with lightweight fakes.
// ============================================================================

import type { Vec2 } from "../core/math";

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface DiagPart {
  hp: number;
  maxHp: number;
}

export interface DiagEntity {
  id: string;
  name?: string;
  kind: string;
  team: string;
  position: Vec2;
  radius: number;
  height?: number;
  status: { alive: boolean };
  parts: DiagPart[];
}

export interface DiagProjectile {
  id: string;
  position: Vec2;
}

export interface DiagSim {
  phase: string;
  turn: number;
  mode?: string;
  selectedId?: string;
  entities: DiagEntity[];
  projectiles: DiagProjectile[];
  effects: Array<{ id: string }>;
}

export type ScreenProjector = (point: Vec2, height?: number) => {
  x: number;
  y: number;
  visible: boolean;
  behind: boolean;
};

export interface PerfLike {
  fps: number;
  render: { calls: number; triangles: number } | null;
  frame: { jankRatio: number; max: number };
}

export interface Issue {
  severity: "error" | "warn";
  code: string;
  message: string;
  entityId?: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: Issue[];
}

const POSITIONAL_KINDS_EXCLUDED = new Set(["cover", "wall"]);

function finite(n: number): boolean {
  return Number.isFinite(n);
}

function hpTotals(parts: DiagPart[]): { hp: number; max: number } {
  let hp = 0;
  let max = 0;
  for (const p of parts) {
    hp += Math.max(0, p.hp);
    max += p.maxHp;
  }
  return { hp, max };
}

export interface DiagnosticsOptions {
  bounds: Bounds;
  project?: ScreenProjector;
  perf?: PerfLike;
  /** Frames above this many draw calls is flagged. */
  drawCallBudget?: number;
  /** FPS below this (with a populated window) is flagged. */
  fpsFloor?: number;
}

/** Scan sim + render state for anomalies. Pure given its inputs. */
export function runDiagnostics(sim: DiagSim, opts: DiagnosticsOptions): DiagnosticsReport {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], code: string, message: string, entityId?: string) =>
    issues.push({ severity, code, message, entityId });

  const { bounds } = opts;
  const margin = 3;
  const movers = sim.entities.filter((e) => !POSITIONAL_KINDS_EXCLUDED.has(e.kind));

  for (const e of sim.entities) {
    // Invalid coordinates — a NaN/Infinity position renders nowhere or crashes the camera.
    if (!finite(e.position.x) || !finite(e.position.z)) {
      add("error", "nan-position", `${e.kind} ${e.id} has a non-finite position (${e.position.x}, ${e.position.z})`, e.id);
      continue;
    }
    // A live unit far outside the playable arena is almost always a bug.
    if (
      e.status.alive &&
      (e.position.x < bounds.minX - margin || e.position.x > bounds.maxX + margin ||
        e.position.z < bounds.minZ - margin || e.position.z > bounds.maxZ + margin)
    ) {
      add("warn", "out-of-bounds", `${e.kind} ${e.id} sits outside the arena at (${e.position.x.toFixed(1)}, ${e.position.z.toFixed(1)})`, e.id);
    }
    // Part HP sanity: non-finite, or hp exceeding maxHp.
    for (const p of e.parts) {
      if (!finite(p.hp) || !finite(p.maxHp)) {
        add("error", "nan-hp", `${e.kind} ${e.id} has a non-finite part HP`, e.id);
        break;
      }
      if (p.hp > p.maxHp + 0.01) {
        add("warn", "hp-overflow", `${e.kind} ${e.id} has a part above max HP (${p.hp.toFixed(0)}/${p.maxHp})`, e.id);
        break;
      }
    }
    // Status/HP inconsistency: marked alive but every part is destroyed (should be dead).
    if (e.status.alive && e.parts.length > 0 && e.parts.every((p) => p.hp <= 0)) {
      add("warn", "alive-but-destroyed", `${e.kind} ${e.id} is flagged alive but all parts are at 0 HP`, e.id);
    }
  }

  // Stacked units — two living movers whose centers overlap badly read as one blob.
  for (let i = 0; i < movers.length; i += 1) {
    const a = movers[i];
    if (!a.status.alive || !finite(a.position.x)) continue;
    for (let j = i + 1; j < movers.length; j += 1) {
      const b = movers[j];
      if (!b.status.alive || !finite(b.position.x)) continue;
      const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      if (d < (a.radius + b.radius) * 0.5) {
        add("warn", "overlap", `${a.kind} ${a.id} and ${b.kind} ${b.id} overlap (centers ${d.toFixed(2)} apart)`, a.id);
      }
    }
  }

  // Stuck/invalid projectiles.
  for (const p of sim.projectiles) {
    if (!finite(p.position.x) || !finite(p.position.z)) {
      add("error", "nan-projectile", `projectile ${p.id} has a non-finite position`, p.id);
    }
  }

  // Field emptiness — an in-battle phase with no units at all is a broken scenario/restore.
  if ((sim.phase === "command" || sim.phase === "resolve") && sim.entities.length === 0) {
    add("error", "empty-field", `phase is ${sim.phase} but there are no entities on the field`);
  }

  // Camera framing — the selected unit should be visible; if not, the camera-assist failed.
  if (opts.project && sim.selectedId) {
    const sel = sim.entities.find((e) => e.id === sim.selectedId);
    if (sel && finite(sel.position.x)) {
      const s = opts.project(sel.position, (sel.height ?? 1) * 0.6);
      if (!s.visible) {
        add("warn", "selected-offscreen", `selected ${sel.kind} ${sel.id} is framed off-screen`, sel.id);
      }
    }
  }

  // Performance anomalies.
  if (opts.perf) {
    const budget = opts.drawCallBudget ?? 1200;
    const floor = opts.fpsFloor ?? 30;
    if (opts.perf.render && opts.perf.render.calls > budget) {
      add("warn", "draw-call-spike", `${opts.perf.render.calls} draw calls/frame exceeds the ${budget} budget`);
    }
    if (opts.perf.fps > 0 && opts.perf.fps < floor) {
      add("warn", "low-fps", `average FPS ${opts.perf.fps.toFixed(1)} is below the ${floor} floor`);
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  return { ok: errors === 0, errors, warnings, issues };
}

// ---------------------------------------------------------------------------
//  Scene description — structured, projected, AI-readable.
// ---------------------------------------------------------------------------

export interface DescribedEntity {
  id: string;
  kind: string;
  team: string;
  hp: number;
  maxHp: number;
  hpPct: number;
  alive: boolean;
  world: { x: number; z: number };
  screen: { x: number; y: number; visible: boolean } | null;
  selected: boolean;
  targeted: boolean;
}

export interface SceneDescription {
  phase: string;
  turn: number;
  mode?: string;
  selectedId?: string;
  counts: { entities: number; player: number; enemy: number; projectiles: number; effects: number };
  entities: DescribedEntity[];
  summary: string;
}

export interface DescribeOptions {
  project?: ScreenProjector;
  selectedId?: string;
  targetedId?: string;
}

/** Build a structured + summarized readout of the scene that an AI/agent can reason over. */
export function describeScene(sim: DiagSim, opts: DescribeOptions = {}): SceneDescription {
  const selectedId = opts.selectedId ?? sim.selectedId;
  const entities: DescribedEntity[] = sim.entities.map((e) => {
    const { hp, max } = hpTotals(e.parts);
    const screen =
      opts.project && finite(e.position.x)
        ? (() => {
            const s = opts.project!(e.position, (e.height ?? 1) * 0.6);
            return { x: Math.round(s.x), y: Math.round(s.y), visible: s.visible };
          })()
        : null;
    return {
      id: e.id,
      kind: e.kind,
      team: e.team,
      hp: Math.round(hp),
      maxHp: Math.round(max),
      hpPct: max > 0 ? Math.round((hp / max) * 100) : 0,
      alive: e.status.alive,
      world: { x: round1(e.position.x), z: round1(e.position.z) },
      screen,
      selected: e.id === selectedId,
      targeted: e.id === opts.targetedId,
    };
  });

  const player = entities.filter((e) => e.team === "player").length;
  const enemy = entities.filter((e) => e.team === "enemy").length;
  const aliveUnits = entities.filter((e) => e.alive && e.kind !== "cover" && e.kind !== "wall");
  const summary =
    `Turn ${sim.turn} · ${sim.phase}${sim.mode ? ` · ${sim.mode}` : ""}. ` +
    `${aliveUnits.length} live units (P${player}/E${enemy}), ` +
    `${sim.projectiles.length} projectiles, ${sim.effects.length} effects. ` +
    (selectedId ? `Selected: ${selectedId}.` : "Nothing selected.");

  return {
    phase: sim.phase,
    turn: sim.turn,
    mode: sim.mode,
    selectedId,
    counts: { entities: entities.length, player, enemy, projectiles: sim.projectiles.length, effects: sim.effects.length },
    entities,
    summary,
  };
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}
