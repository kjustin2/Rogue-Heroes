// ============================================================================
//  SCENARIO GALLERY — demonstrates the in-game debug scenario system by cutting
//  straight to every registered scenario (window.__rht.scenario(id)) and saving a
//  screenshot of each. This is the "automated tests can jump to a scenario and
//  take a screenshot" capability in one runnable script.
//
//  Output: improve/scenario-gallery/<id>.png  +  index.json
//  Run:    npm run improve:gallery   (from game/)
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer, findChromium, sampleCanvas, delay } from "./lib/harness.mjs";

const PORT = Number(process.env.IMPROVE_PORT ?? 5181);
const outDir = join(process.cwd(), "improve", "scenario-gallery");
mkdirSync(outDir, { recursive: true });

const results = [];

const main = async () => {
  const { server, url } = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu", { timeout: 15000 });

    const scenarios = await page.evaluate(() => window.__rht.scenarios());
    if (!scenarios?.length) throw new Error("No scenarios registered on window.__rht");

    for (const sc of scenarios) {
      // Cut straight to the scenario, then deselect for a clean, unobstructed shot.
      const probe = await page.evaluate((id) => {
        const ok = window.__rht.scenario(id);
        const sim = window.__rht.sim;
        return {
          ok,
          map: sim.mapDef.id,
          phase: sim.phase,
          players: sim.fieldUnitCount("player"),
          enemies: sim.fieldUnitCount("enemy"),
          entities: sim.entities.length,
        };
      }, sc.id);
      // End-screen scenarios keep their overlay; in-battle ones get a clean field.
      if (probe.phase === "command") await page.evaluate(() => window.__rht.deselect());
      await delay(650); // let the camera settle + a few frames render
      const file = `${sc.id}.png`;
      await page.screenshot({ path: join(outDir, file) });
      const canvas = await sampleCanvas(page).catch(() => ({ ok: false }));
      results.push({ ...sc, ...probe, canvasLit: canvas.ok, file });
      console.log(`  ${probe.ok ? "✓" : "✗"} ${sc.id.padEnd(14)} ${probe.map.padEnd(10)} ${probe.phase.padEnd(8)} P${probe.players}/E${probe.enemies} -> ${file}`);
    }

    writeFileSync(join(outDir, "index.json"), JSON.stringify({ count: results.length, consoleErrors, results }, null, 2));
    if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.slice(0, 8).join("\n")}`);
    console.log(`\nGallery: ${results.length} scenarios -> ${outDir}`);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
};

try {
  await main();
} catch (err) {
  console.error("scenario-gallery error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
}
