// Visual verification for the new feature pass: dynamic map events (sandstorm / barrage /
// collapse), resolve-phase juice (floating damage numbers + hit flash), and the tech-tree
// specialization panel. Boots a dev server, drives window.__rht, and saves framed screenshots
// for self-review. Run: node scripts/verify-features.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer, findChromium, delay } from "../improve/lib/harness.mjs";

const PORT = Number(process.env.VERIFY_PORT ?? 5188);
const outDir = join(process.cwd(), "improve", "verify-features");
mkdirSync(outDir, { recursive: true });

const shot = async (page, name) => {
  await page.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  📸 ${name}.png`);
};

const main = async () => {
  const { server, url } = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const consoleErrors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));
    await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu", { timeout: 15000 });

    const stage = async (id) => {
      await page.evaluate((sid) => { window.__rht.scenario(sid); window.__rht.deselect?.(); }, id);
      await delay(700);
    };

    // 1. Baseline busy field (no events) for comparison.
    await stage("stress");
    await shot(page, "01-baseline");

    // 2. Sandstorm — fog thickens + sand tint, accuracy drops. Wait for the eased blend to ramp.
    await stage("stress");
    await page.evaluate(() => window.__rht.sim.debugForceEvent("sandstorm"));
    await delay(2600);
    await shot(page, "02-sandstorm");

    // 3. Barrage — danger ring telegraphed during planning, then shells walk the zone in resolve.
    await stage("stress");
    await page.evaluate(() => window.__rht.sim.debugForceEvent("barrage", { x: 0, z: 0, radius: 6 }));
    await delay(500);
    await shot(page, "03-barrage-warning");
    await page.evaluate(() => window.__rht.endTurn());
    await delay(2600);
    await shot(page, "04-barrage-strike");

    // 4. Collapsing cover — dust detonations wreck cover in the zone.
    await stage("stress");
    await page.evaluate(() => window.__rht.sim.debugForceEvent("collapse", { x: 0, z: 0, radius: 13 }));
    await page.evaluate(() => window.__rht.endTurn());
    await delay(2600);
    await shot(page, "05-collapse");

    // 5. Resolve juice — floating damage numbers + hit flash from ordinary gunfire.
    await stage("stress");
    await page.evaluate(() => window.__rht.endTurn());
    await delay(1800);
    await shot(page, "06-damage-numbers");

    // 6. Tech specialization panel — base deck with the new mutually-exclusive side-grades.
    await page.evaluate(() => {
      window.__rht.startBattle("ironworks", "destroy", "normal");
      const sim = window.__rht.sim;
      const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
      base.unlockedTech = ["recon", "assault", "support", "armor"];
      sim.economy.set("player", 9999);
      base.commandPoints = 3;
      sim.select(base.id);
    });
    await delay(500);
    await shot(page, "07-tech-panel");

    // 7. Onboarding — contextual first-time hint toast once a unit is deployed.
    await page.evaluate(() => {
      try { localStorage.removeItem("rht.hints.v1"); } catch {}
      window.__rht.startBattle("ironworks", "destroy", "normal");
      const sim = window.__rht.sim;
      const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
      sim.economy.set("player", 9999);
      base.commandPoints = 3;
      sim.select(base.id);
      window.__rht.queueSpawnTroop("soldier");
    });
    await delay(700);
    await shot(page, "08-onboarding");

    const env = await page.evaluate(() => window.__rht.environment());
    writeFileSync(join(outDir, "summary.json"), JSON.stringify({ at: "verify", env, consoleErrors }, null, 2));
    console.log(`\nConsole errors: ${consoleErrors.length}`);
    for (const e of consoleErrors.slice(0, 8)) console.log(`   - ${e}`);
    console.log(`Saved to ${outDir}`);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
};

try {
  await main();
} catch (err) {
  console.error("verify-features error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
}
