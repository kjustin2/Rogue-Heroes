// Visual + persistence verification for the campaign / armory / atmosphere pass. Boots a dev
// server, drives window.__rht and the menus, screenshots the new screens, and — critically —
// reloads the page to prove campaign progress and the in-battle save survive closing the game.
// Run: node scripts/verify-campaign.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startServer, findChromium, delay } from "../improve/lib/harness.mjs";

const PORT = Number(process.env.VERIFY_PORT ?? 5189);
const outDir = join(process.cwd(), "improve", "verify-campaign");
mkdirSync(outDir, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); };

const main = async () => {
  const { server, url } = await startServer(PORT);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const consoleErrors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));
    const shot = async (n) => { await page.screenshot({ path: join(outDir, `${n}.png`) }); console.log(`  📸 ${n}.png`); };

    await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu", { timeout: 15000 });
    // Start from a clean slate so the campaign begins at mission 1.
    await page.evaluate(() => { try { localStorage.removeItem("rht.campaign.v1"); } catch {} });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu");
    await shot("01-main-menu");

    // Campaign mission select.
    await page.click('[data-menu="campaign"]');
    await page.waitForSelector(".campaign-list", { timeout: 8000 });
    await delay(200);
    await shot("02-campaign-menu");
    const missionCount = await page.$$eval(".campaign-card", (els) => els.length);
    check("campaign menu lists missions", missionCount >= 8, `${missionCount} cards`);

    // Briefing for the first mission.
    await page.click('.campaign-card[data-mission]:not([disabled])');
    await page.waitForSelector(".briefing-screen", { timeout: 8000 });
    await delay(200);
    await shot("03-briefing");

    // Armory (categories).
    await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu");
    await page.click('[data-menu="armory"]');
    await page.waitForSelector(".armory-screen", { timeout: 8000 });
    await delay(200);
    await shot("04-armory");
    const categoryCount = await page.$$eval(".armory-category-title", (els) => els.length);
    check("armory shows multiple categories", categoryCount >= 3, `${categoryCount} categories`);

    // Win mission 1 and show the campaign victory overlay (advances the ladder + persists).
    await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu");
    await page.evaluate(() => {
      window.__rht.startCampaign("m1-cold-start");
      const s = window.__rht.sim;
      s.debugDefeatTeam("enemy");
      s.debugSetPhase("victory");
    });
    await delay(700);
    await page.waitForSelector(".campaign-overlay", { timeout: 8000 });
    await shot("05-campaign-victory");

    // Back to mission select — mission 1 should now read cleared and mission 2 unlocked.
    await page.click('.campaign-overlay [data-menu-btn]');
    await page.waitForSelector(".campaign-list", { timeout: 8000 });
    await delay(200);
    await shot("06-progress");
    const cleared = await page.$$eval(".campaign-card.completed", (els) => els.length);
    const unlocked2 = await page.$eval('.campaign-card[data-mission="m2-the-foundry"]', (el) => !el.disabled);
    check("mission 1 marked cleared", cleared >= 1, `${cleared} cleared`);
    check("mission 2 unlocked after win", unlocked2 === true);

    // PERSISTENCE: reload the whole page and confirm campaign progress survived.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu");
    const persisted = await page.evaluate(() => localStorage.getItem("rht.campaign.v1") ?? "");
    check("campaign progress survives reload", persisted.includes("m1-cold-start"), persisted.slice(0, 80));
    await page.click('[data-menu="campaign"]');
    await page.waitForSelector(".campaign-list");
    const clearedAfterReload = await page.$$eval(".campaign-card.completed", (els) => els.length);
    check("cleared mission still shown after reload", clearedAfterReload >= 1, `${clearedAfterReload} cleared`);
    await shot("07-after-reload");

    // PERSISTENCE: start a mission, save the battle, reload, and resume via Continue.
    await page.goto(`${url}/?lowfx=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu");
    await page.evaluate(() => { window.__rht.startCampaign("m2-the-foundry"); window.__rht.save(); });
    await delay(300);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".main-menu");
    const hasContinue = (await page.$('[data-menu="continue"]')) !== null;
    check("Continue Battle offered after reload", hasContinue);
    if (hasContinue) {
      await page.click('[data-menu="continue"]');
      await delay(700);
      const resumed = await page.evaluate(() => ({ map: window.__rht.sim.mapDef.id, phase: window.__rht.sim.phase, menus: document.querySelectorAll(".main-menu").length }));
      check("resumed the saved campaign battle", resumed.map === "ironworks" && resumed.menus === 0, JSON.stringify(resumed));
      await shot("08-resumed");
    }

    // Atmosphere: ambient snow + an ion storm on the Frozen Causeway (high-ground scenario),
    // with the command deck closed so the battlefield is visible.
    await page.evaluate(() => { window.__rht.scenario("high-ground"); window.__rht.deselect(); });
    await delay(1200);
    await shot("09-ambient-snow");
    await page.evaluate(() => window.__rht.sim.debugForceEvent("ionstorm"));
    await delay(1600);
    await shot("10-ionstorm");
    const env = await page.evaluate(() => window.__rht.environment());
    check("ion storm active", env.ionstorm === 1);

    writeFileSync(join(outDir, "summary.json"), JSON.stringify({ results, consoleErrors }, null, 2));
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed · console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors.slice(0, 8)) console.log(`   - ${e}`);
    if (failed.length || consoleErrors.length) process.exitCode = 1;
    console.log(`Saved to ${outDir}`);
  } finally {
    await browser.close();
    if (server) server.kill();
  }
};

try {
  await main();
} catch (err) {
  console.error("verify-campaign error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
}
