// ============================================================================
//  CHECK — evaluate every goal against the captured evidence for one cycle.
// ----------------------------------------------------------------------------
//  Inputs (all under CYCLE_DIR):
//    state.json            — the play-through trace (logical signal source)
//    vitest.json           — `vitest run --reporter=json` output (logic tests)
//    shots/NN-*.png        — screenshots (visual presence signal)
//    visual-verdicts.json  — { goalId: { pass, note } } agent visual verdicts
//
//  Output (under CYCLE_DIR):
//    goals.json            — machine-readable per-goal result
//    report.md             — human-readable per-cycle report
//
//  A goal is MET iff:  logical.pass  AND  (no visual OR (present AND semantic)).
//  Exit code is 0 always (the loop reads the report regardless of pass/fail).
// ============================================================================

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, isAbsolute, basename } from "node:path";
import { GOALS } from "./goals.mjs";

const cycleDir = process.env.CYCLE_DIR
  ? (isAbsolute(process.env.CYCLE_DIR) ? process.env.CYCLE_DIR : join(process.cwd(), process.env.CYCLE_DIR))
  : join(process.cwd(), "improve", "cycles", "adhoc");

const cycleName = basename(cycleDir);

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

const trace = readJson(join(cycleDir, "state.json"), { steps: [], consoleErrors: [], runError: "state.json missing" });
const verdicts = readJson(join(cycleDir, "visual-verdicts.json"), {});
const vitestRaw = readJson(join(cycleDir, "vitest.json"), null);

// ---- Normalize the vitest summary ----------------------------------------
const vitest = (() => {
  if (!vitestRaw) return { ok: null, passed: [], failed: [], note: "no vitest.json" };
  const passed = [];
  const failed = [];
  for (const file of vitestRaw.testResults ?? []) {
    for (const a of file.assertionResults ?? []) {
      const title = [a.ancestorTitles?.join(" "), a.title].filter(Boolean).join(" ").trim();
      if (a.status === "passed") passed.push(title);
      else failed.push(title);
    }
  }
  return { ok: vitestRaw.success === true && failed.length === 0, passed, failed };
})();

// ---- Trace step lookup ----------------------------------------------------
const byStep = new Map((trace.steps ?? []).map((s) => [s.step, s]));
const ctx = {
  trace: trace.steps ?? [],
  vitest,
  step: (name) => byStep.get(name),
};

// ---- Visual presence: file exists and is plausibly non-blank --------------
function visualPresence(goal) {
  if (!goal.visual) return { present: true, note: "no visual" };
  const path = join(cycleDir, "shots", goal.visual.shot);
  if (!existsSync(path)) return { present: false, note: `missing ${goal.visual.shot}` };
  const size = statSync(path).size;
  // Find the step that produced this shot to surface its canvas-lit signal (in-game shots).
  const owner = (trace.steps ?? []).find((s) => s.shot === goal.visual.shot);
  const canvasOk = owner?.canvas?.ok;
  const present = size > 2048; // a real 1600x900 PNG is far larger; guards against empty writes
  return { present, note: `${(size / 1024).toFixed(0)}KB${canvasOk === undefined ? "" : ` canvasLit=${canvasOk}`}` };
}

// ---- Evaluate every goal --------------------------------------------------
const results = GOALS.map((goal) => {
  let logical;
  try { logical = goal.logical ? goal.logical(ctx) : { pass: true, detail: "no logical assertion" }; }
  catch (err) { logical = { pass: false, detail: `assertion threw: ${err?.message ?? err}` }; }

  const presence = visualPresence(goal);
  const verdict = goal.visual ? verdicts[goal.id] : { pass: true, note: "no visual" };
  const semantic = goal.visual
    ? (verdict ? Boolean(verdict.pass) : null) // null = pending agent review
    : true;

  const visualOk = goal.visual ? (presence.present && semantic === true) : true;
  const met = logical.pass === true && visualOk;

  return {
    id: goal.id,
    title: goal.title,
    category: goal.category,
    met,
    logical: { pass: logical.pass === true, detail: logical.detail },
    visual: goal.visual
      ? { shot: goal.visual.shot, lookFor: goal.visual.lookFor, present: presence.present, presenceNote: presence.note, semantic, verdictNote: verdict?.note ?? null }
      : null,
  };
});

const metCount = results.filter((r) => r.met).length;
const allMet = metCount === results.length;
const pendingVisual = results.filter((r) => r.visual && r.visual.semantic === null && r.logical.pass && r.visual.present);

const summary = {
  cycle: cycleName,
  total: results.length,
  met: metCount,
  allMet,
  vitest: { ok: vitest.ok, failed: vitest.failed },
  consoleErrors: (trace.consoleErrors ?? []).slice(0, 12),
  runError: trace.runError ?? null,
  pendingVisualReview: pendingVisual.map((r) => r.id),
  results,
};

writeFileSync(join(cycleDir, "goals.json"), JSON.stringify(summary, null, 2));

// ---- Human-readable report ------------------------------------------------
const icon = (r) => (r.met ? "✅" : r.logical.pass ? (r.visual && r.visual.semantic === null ? "👁️ " : "❌") : "❌");
const lines = [];
lines.push(`# Improvement cycle report — ${cycleName}`);
lines.push("");
lines.push(`**Goals met: ${metCount} / ${results.length}**  ·  vitest: ${vitest.ok === null ? "not run" : vitest.ok ? "green" : `RED (${vitest.failed.length} failing)`}  ·  console errors: ${(trace.consoleErrors ?? []).length}`);
if (trace.runError) lines.push(`\n> ⚠️ capture runError: \`${String(trace.runError).split("\n")[0]}\``);
if (pendingVisual.length) lines.push(`\n> 👁️ Awaiting visual review: ${pendingVisual.map((r) => r.id).join(", ")}`);
lines.push("");
lines.push("| | Goal | Logical | Visual |");
lines.push("|---|---|---|---|");
for (const r of results) {
  const vis = r.visual
    ? `${r.visual.present ? "present" : "**MISSING**"} / ${r.visual.semantic === null ? "_pending_" : r.visual.semantic ? "ok" : "**no**"} — \`${r.visual.shot}\``
    : "—";
  lines.push(`| ${icon(r)} | **${r.id}** ${r.title} | ${r.logical.pass ? "pass" : "**fail**"}: ${r.logical.detail} | ${vis} |`);
}
lines.push("");
if (vitest.failed.length) {
  lines.push("## Failing vitest tests");
  for (const t of vitest.failed) lines.push(`- ${t}`);
  lines.push("");
}
const notMet = results.filter((r) => !r.met);
if (notMet.length) {
  lines.push("## Remaining gaps");
  for (const r of notMet) {
    const why = [];
    if (!r.logical.pass) why.push(`logic: ${r.logical.detail}`);
    if (r.visual && !r.visual.present) why.push(`screenshot missing`);
    if (r.visual && r.visual.semantic === null) why.push(`needs visual review of ${r.visual.shot} (look for: ${r.visual.lookFor})`);
    if (r.visual && r.visual.semantic === false) why.push(`visual rejected: ${r.visual.verdictNote ?? "did not show the intended result"}`);
    lines.push(`- **${r.id}** — ${why.join("; ")}`);
  }
  lines.push("");
}
lines.push(allMet ? "## ✅ ALL GOALS MET — loop may stop." : `## ⏳ ${results.length - metCount} goal(s) remaining — continue the loop.`);

writeFileSync(join(cycleDir, "report.md"), lines.join("\n"));

console.log(`[check-goals] ${cycleName}: ${metCount}/${results.length} met` +
  `${allMet ? " — ALL MET" : ""}` +
  `${pendingVisual.length ? ` (${pendingVisual.length} awaiting visual review)` : ""}`);
console.log(`  report -> ${join(cycleDir, "report.md")}`);
