// ============================================================================
//  VISION — AI-readable inspection of the game's visuals.
// ----------------------------------------------------------------------------
//  For each requested scenario (or the live battle), this captures:
//    * clean.png      — the raw frame (what the player sees)
//    * annotated.png  — the same frame with the in-game debug overlay on, so
//                       every unit is labelled with kind / id / HP at its
//                       on-screen position (the screenshot becomes self-describing)
//    * scene.json     — describeScene() + diagnostics(): every entity with world
//                       AND screen coordinates, HP, selection, plus the anomaly scan
//    * report.md      — a compact, human/AI-friendly digest of the above
//
//  This is the "help Claude see the visuals + catch bugs" tool: hand the agent
//  annotated.png next to report.md and it can map pixels to game state and spot
//  off-screen units, stacked blobs, NaN positions, draw-call spikes, etc.
//
//  Run:  npm run vision               # a curated set of scenarios
//        npm run vision -- siege      # one scenario
//        npm run vision -- all        # every registered scenario
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer, findChromium, sampleCanvas, delay } from "./lib/harness.mjs";

const PORT = Number(process.env.VISION_PORT ?? 5183);
const outRoot = join(process.cwd(), "improve", "vision");
mkdirSync(outRoot, { recursive: true });

const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
const CURATED = ["roster", "siege", "firefight", "high-ground", "stress"];

const main = async () => {
  const { server, url } = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const index = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu", { timeout: 15000 });

    const all = await page.evaluate(() => window.__rht.scenarios().map((s) => s.id));
    const targets = arg === "all" ? all : arg ? [arg] : CURATED.filter((id) => all.includes(id));

    for (const id of targets) {
      const dir = join(outRoot, id);
      mkdirSync(dir, { recursive: true });

      const staged = await page.evaluate((sid) => {
        const ok = window.__rht.scenario(sid);
        const sim = window.__rht.sim;
        if (sim.phase === "command") window.__rht.deselect();
        return { ok, phase: sim.phase };
      }, id);
      if (!staged.ok) {
        console.log(`  ✗ ${id.padEnd(14)} (no such scenario)`);
        index.push({ id, ok: false });
        continue;
      }
      await delay(650); // camera settle + a few frames

      // Clean frame (overlay off).
      await page.evaluate(() => window.__rht.setDebugOverlay(false));
      await delay(60);
      await page.screenshot({ path: join(dir, "clean.png") });

      // Annotated frame (overlay on).
      await page.evaluate(() => window.__rht.setDebugOverlay(true));
      await delay(120);
      await page.screenshot({ path: join(dir, "annotated.png") });
      await page.evaluate(() => window.__rht.setDebugOverlay(false));

      // Structured readout.
      const data = await page.evaluate(() => ({
        scene: window.__rht.describeScene(),
        diagnostics: window.__rht.diagnostics(),
        perf: window.__rht.perf(),
      }));
      const canvas = await sampleCanvas(page).catch(() => ({ ok: false }));

      writeFileSync(join(dir, "scene.json"), JSON.stringify({ id, canvasLit: canvas.ok, ...data }, null, 2));
      writeFileSync(join(dir, "report.md"), renderSceneReport(id, data, canvas.ok));

      const errs = data.diagnostics.errors;
      const warns = data.diagnostics.warnings;
      index.push({ id, ok: true, entities: data.scene.counts.entities, errors: errs, warnings: warns, canvasLit: canvas.ok });
      console.log(`  ${errs ? "❌" : warns ? "⚠️ " : "✓ "}${id.padEnd(14)} ${String(data.scene.counts.entities).padStart(3)} ents · ${errs}E/${warns}W · canvas ${canvas.ok ? "lit" : "BLANK"} -> ${id}/annotated.png`);
    }

    writeFileSync(join(outRoot, "index.json"), JSON.stringify({ at: new Date().toISOString(), consoleErrors, scenarios: index }, null, 2));
    if (consoleErrors.length) {
      console.log(`\n  ${consoleErrors.length} console error(s):`);
      for (const e of consoleErrors.slice(0, 8)) console.log(`   - ${e}`);
    }
    console.log(`\nVision: ${index.length} scenario(s) -> ${outRoot}`);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
};

function renderSceneReport(id, data, canvasLit) {
  const { scene, diagnostics, perf } = data;
  const L = [];
  L.push(`# Vision — scenario \`${id}\``);
  L.push("");
  L.push(`> ${scene.summary}`);
  L.push("");
  L.push(`- canvas: ${canvasLit ? "painted ✅" : "**BLANK ❌**"}`);
  L.push(`- entities: ${scene.counts.entities} (player ${scene.counts.player} / enemy ${scene.counts.enemy})`);
  L.push(`- perf: ${perf.fps} fps · ${perf.render?.calls ?? "?"} draw calls · ${perf.render?.triangles ?? "?"} triangles · ${perf.sceneObjects ?? "?"} scene objects`);
  L.push(`- diagnostics: **${diagnostics.errors} errors, ${diagnostics.warnings} warnings**`);
  L.push("");

  if (diagnostics.issues.length) {
    L.push("## Anomalies");
    for (const i of diagnostics.issues) L.push(`- ${i.severity === "error" ? "❌" : "⚠️"} \`${i.code}\` ${i.message}`);
    L.push("");
  }

  // Entity table — the key to reading annotated.png. Sorted by team then kind.
  const rows = [...scene.entities]
    .filter((e) => e.kind !== "cover")
    .sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : a.kind.localeCompare(b.kind)));
  L.push("## Entities (screen coords match annotated.png)");
  L.push("| id | kind | team | HP | world (x,z) | screen (x,y) | on-screen | sel |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const e of rows) {
    const screen = e.screen ? `${e.screen.x},${e.screen.y}` : "—";
    const vis = e.screen ? (e.screen.visible ? "yes" : "off") : "—";
    L.push(`| ${e.id} | ${e.kind} | ${e.team} | ${e.hp}/${e.maxHp} (${e.hpPct}%) | ${e.world.x},${e.world.z} | ${screen} | ${vis} | ${e.selected ? "◀" : ""} |`);
  }
  L.push("");
  L.push("_Open `annotated.png` to see these labels drawn over each unit; `clean.png` is the unannotated frame._");
  return L.join("\n");
}

try {
  await main();
} catch (err) {
  console.error("vision error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
}
