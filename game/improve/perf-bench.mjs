// ============================================================================
//  PERF BENCH — measure frame cost + draw work and guard against regressions.
// ----------------------------------------------------------------------------
//  Boots the game headless, cuts to the heavy `stress` scenario, and samples the
//  in-page PerfMonitor (window.__rht.perf()) across the command phase and the
//  resolve phase. Then runs a memory-churn probe (repeated scenario swaps) to
//  catch geometry/texture leaks.
//
//  The hard regression gates are the *deterministic* signals that don't depend
//  on the (SwiftShader) headless GPU speed: draw calls, triangles, live scene
//  objects, and geometry/texture growth across churn. Frame time / FPS are
//  reported as advisory (headless rasterization is far slower than a real GPU).
//
//  Output (improve/perf/):  perf-report.json + perf-report.md
//  Baseline (improve/perf-baseline.json) is compared and, with --update-baseline
//  (or when missing), (re)written.
//
//  Run:  npm run perf            # measure + compare
//        npm run perf -- --update-baseline
// ============================================================================

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer, findChromium, delay } from "./lib/harness.mjs";

const PORT = Number(process.env.PERF_PORT ?? 5182);
const root = process.cwd();
const outDir = join(root, "improve", "perf");
const baselinePath = join(root, "improve", "perf-baseline.json");
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const updateBaseline = argv.includes("--update-baseline");

// Regression tolerances. Cost signals may grow this much before we flag; FPS may drop this far.
const COST_TOLERANCE = 1.15; // +15% draw calls / triangles / objects
const FPS_TOLERANCE = 0.8; // -20% fps
const LEAK_TOLERANCE = 1.1; // +10% live geometries/textures/objects across churn

const consoleErrors = [];

/** Reset the in-page perf window, let real frames accumulate, then read the aggregate. */
async function measure(page, label, ms) {
  await page.evaluate(() => window.__rht.perfReset());
  await delay(ms);
  const snap = await page.evaluate(() => window.__rht.perf());
  return { label, ...snap };
}

/** Sample perf continuously while the sim is in the resolve phase (after an endTurn). */
async function measureResolve(page, ms) {
  await page.evaluate(() => { window.__rht.perfReset(); window.__rht.endTurn(); });
  const start = Date.now();
  // Keep the page busy resolving; poll phase so we stop once it returns to command.
  while (Date.now() - start < ms) {
    const phase = await page.evaluate(() => window.__rht.sim.phase);
    if (phase !== "resolve" && Date.now() - start > 800) break;
    await delay(120);
  }
  const snap = await page.evaluate(() => window.__rht.perf());
  return { label: "resolve-stress", ...snap };
}

const main = async () => {
  const { server, url } = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const measurements = [];
  let churn = null;
  let diagnostics = null;
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu", { timeout: 15000 });

    // --- Light reference: the default battle start (few entities) ---
    await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
    await delay(600);
    await page.evaluate(() => window.__rht.deselect());
    measurements.push(await measure(page, "command-light", 3000));

    // --- Heavy: the stress scenario (command phase, steady state) ---
    const staged = await page.evaluate(() => {
      const ok = window.__rht.scenario("stress");
      window.__rht.deselect();
      const sim = window.__rht.sim;
      return { ok, entities: sim.entities.length, players: sim.fieldUnitCount("player"), enemies: sim.fieldUnitCount("enemy") };
    });
    if (!staged.ok) throw new Error("Failed to stage the 'stress' scenario");
    await delay(800);
    measurements.push(await measure(page, "command-stress", 3500));

    // Capture diagnostics on the crowded field (anomaly scan under load).
    diagnostics = await page.evaluate(() => window.__rht.diagnostics());

    // --- Heavy: the stress scenario resolving (projectiles + damage) ---
    measurements.push(await measureResolve(page, 6000));

    // --- Memory-churn leak probe: repeated scenario swaps must not grow live GPU memory ---
    await page.evaluate(() => { window.__rht.scenario("stress"); window.__rht.deselect(); });
    await delay(700);
    const before = await page.evaluate(() => window.__rht.perf());
    const ids = await page.evaluate(() => window.__rht.scenarios().map((s) => s.id));
    for (let i = 0; i < 8; i += 1) {
      const id = ids[i % ids.length];
      await page.evaluate((sid) => window.__rht.scenario(sid), id);
      await delay(120);
    }
    await page.evaluate(() => { window.__rht.scenario("stress"); window.__rht.deselect(); });
    await delay(900);
    const after = await page.evaluate(() => window.__rht.perf());
    churn = {
      swaps: 8,
      before: { geometries: before.render?.geometries, textures: before.render?.textures, sceneObjects: before.sceneObjects },
      after: { geometries: after.render?.geometries, textures: after.render?.textures, sceneObjects: after.sceneObjects },
    };
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  // ---- Assemble the report -------------------------------------------------
  const byLabel = Object.fromEntries(measurements.map((m) => [m.label, m]));
  const current = {
    command: slim(byLabel["command-stress"]),
    resolve: slim(byLabel["resolve-stress"]),
    light: slim(byLabel["command-light"]),
  };

  const baseline = existsSync(baselinePath) ? readJson(baselinePath, null) : null;
  // Hard gate = the deterministic draw-work signals (identical run-to-run). FPS is reported as
  // an advisory only: headless SwiftShader frame time swings wildly (10–140 fps seen), so gating
  // on it would make the harness flaky.
  const regressions = [];
  const fpsAdvisories = [];
  if (baseline && !updateBaseline) {
    compareCost(regressions, "command draw calls", current.command?.render?.calls, baseline.command?.render?.calls);
    compareCost(regressions, "command triangles", current.command?.render?.triangles, baseline.command?.render?.triangles);
    compareCost(regressions, "command sceneObjects", current.command?.sceneObjects, baseline.command?.sceneObjects);
    compareCost(regressions, "resolve draw calls", current.resolve?.render?.calls, baseline.resolve?.render?.calls);
    compareFps(fpsAdvisories, "command fps", current.command?.fps, baseline.command?.fps);
    compareFps(fpsAdvisories, "resolve fps", current.resolve?.fps, baseline.resolve?.fps);
  }

  // Leak check (independent of baseline).
  const leak = [];
  if (churn) {
    leakCheck(leak, "geometries", churn.before.geometries, churn.after.geometries);
    leakCheck(leak, "textures", churn.before.textures, churn.after.textures);
    leakCheck(leak, "sceneObjects", churn.before.sceneObjects, churn.after.sceneObjects);
  }

  const diagErrors = (diagnostics?.issues ?? []).filter((i) => i.severity === "error");
  const ok = regressions.length === 0 && leak.length === 0 && diagErrors.length === 0 && consoleErrors.length === 0;

  const report = {
    at: new Date().toISOString(),
    ok,
    measurements: measurements.map(slim),
    current,
    baselineUsed: Boolean(baseline) && !updateBaseline,
    regressions,
    fpsAdvisories,
    churn,
    leak,
    diagnostics,
    consoleErrors: consoleErrors.slice(0, 12),
  };
  writeJson(join(outDir, "perf-report.json"), report);
  writeFileSync(join(outDir, "perf-report.md"), renderMarkdown(report));

  if (!baseline || updateBaseline) {
    writeJson(baselinePath, { at: report.at, command: current.command, resolve: current.resolve, light: current.light });
    console.log(`[perf-bench] baseline ${baseline ? "updated" : "established"} -> ${baselinePath}`);
  }

  // ---- Console summary -----------------------------------------------------
  for (const m of measurements) {
    console.log(`  ${m.label.padEnd(16)} ${String(m.fps).padStart(6)} fps · p95 ${String(m.frame.p95).padStart(6)}ms · ${String(m.render?.calls ?? "?").padStart(5)} calls · ${String(m.render?.triangles ?? "?").padStart(7)} tris · ${m.sceneObjects ?? "?"} objs`);
  }
  if (diagErrors.length) console.log(`  diagnostics: ${diagErrors.length} ERROR(s): ${diagErrors.map((i) => i.code).join(", ")}`);
  if (fpsAdvisories.length) console.log(`  (advisory) fps below baseline: ${fpsAdvisories.map((r) => `${r.what} ×${r.ratio}`).join("; ")}`);
  if (regressions.length) console.log(`  ⚠️ ${regressions.length} regression(s): ${regressions.map((r) => r.what).join("; ")}`);
  if (leak.length) console.log(`  ⚠️ possible leak: ${leak.map((l) => l.what).join("; ")}`);
  console.log(`[perf-bench] ${ok ? "OK ✅" : "ISSUES ❌"} -> ${join(outDir, "perf-report.md")}`);
  if (!ok) process.exitCode = 1;
};

// ---- helpers ----------------------------------------------------------------

function slim(m) {
  if (!m) return null;
  return { label: m.label, fps: m.fps, windowMs: m.windowMs, frame: m.frame, render: m.render, sceneObjects: m.sceneObjects };
}

function compareCost(out, what, cur, base) {
  if (typeof cur !== "number" || typeof base !== "number" || base <= 0) return;
  if (cur > base * COST_TOLERANCE) out.push({ what, current: cur, baseline: base, ratio: round2(cur / base) });
}
function compareFps(out, what, cur, base) {
  if (typeof cur !== "number" || typeof base !== "number" || base <= 0) return;
  if (cur < base * FPS_TOLERANCE) out.push({ what, current: cur, baseline: base, ratio: round2(cur / base) });
}
function leakCheck(out, what, before, after) {
  if (typeof before !== "number" || typeof after !== "number" || before <= 0) return;
  if (after > before * LEAK_TOLERANCE) out.push({ what, before, after, ratio: round2(after / before) });
}

function renderMarkdown(r) {
  const L = [];
  L.push(`# Perf bench — ${r.at}`);
  L.push("");
  L.push(`**${r.ok ? "✅ OK" : "❌ ISSUES"}** · baseline ${r.baselineUsed ? "compared" : "(re)written"} · ${r.consoleErrors.length} console errors`);
  L.push("");
  L.push("| Phase | FPS | mean | p95 | p99 | max | jank% | draw calls | triangles | objects |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const m of r.measurements) {
    if (!m) continue;
    L.push(`| ${m.label} | ${m.fps} | ${m.frame.mean} | ${m.frame.p95} | ${m.frame.p99} | ${m.frame.max} | ${(m.frame.jankRatio * 100).toFixed(0)}% | ${m.render?.calls ?? "?"} | ${m.render?.triangles ?? "?"} | ${m.sceneObjects ?? "?"} |`);
  }
  L.push("");
  if (r.regressions.length) {
    L.push("## ⚠️ Regressions vs baseline (draw work — hard gate)");
    for (const g of r.regressions) L.push(`- **${g.what}**: ${g.current} vs baseline ${g.baseline} (×${g.ratio})`);
    L.push("");
  }
  if (r.fpsAdvisories?.length) {
    L.push("## FPS advisories (not gated — headless GPU is noisy)");
    for (const g of r.fpsAdvisories) L.push(`- ${g.what}: ${g.current} vs baseline ${g.baseline} (×${g.ratio})`);
    L.push("");
  }
  if (r.churn) {
    L.push("## Memory-churn leak probe");
    L.push(`After ${r.churn.swaps} scenario swaps:`);
    L.push(`- geometries: ${r.churn.before.geometries} → ${r.churn.after.geometries}`);
    L.push(`- textures: ${r.churn.before.textures} → ${r.churn.after.textures}`);
    L.push(`- scene objects: ${r.churn.before.sceneObjects} → ${r.churn.after.sceneObjects}`);
    L.push(r.leak.length ? `- ⚠️ **possible leak:** ${r.leak.map((l) => `${l.what} ×${l.ratio}`).join(", ")}` : "- ✅ no runaway growth");
    L.push("");
  }
  const diagErrors = (r.diagnostics?.issues ?? []).filter((i) => i.severity === "error");
  const diagWarns = (r.diagnostics?.issues ?? []).filter((i) => i.severity === "warn");
  L.push("## Diagnostics (stress field)");
  L.push(`${diagErrors.length} errors · ${diagWarns.length} warnings`);
  for (const i of (r.diagnostics?.issues ?? []).slice(0, 20)) L.push(`- ${i.severity === "error" ? "❌" : "⚠️"} \`${i.code}\` ${i.message}`);
  L.push("");
  if (r.consoleErrors.length) {
    L.push("## Console errors");
    for (const e of r.consoleErrors) L.push(`- ${e}`);
  }
  return L.join("\n");
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

try {
  await main();
} catch (err) {
  console.error("perf-bench error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
}
