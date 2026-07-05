// Verify the new air units render with distinct silhouettes (helicopter gunship, jet interceptor,
// heavy bomber) and that a gunship can CONFIRM a shot at an enemy flyer (the B5 fix). Out: shots/air/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "air");
mkdirSync(OUT, { recursive: true });
const serverLog = [];
let server = null, browser = null;

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
  return join(base, dir, "chrome-win", "chrome.exe");
}
async function ready(url) { try { return (await fetch(url)).ok; } catch { return false; } }
async function waitForServer(url, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await ready(url)) return; await delay(150); } throw new Error("server: " + serverLog.join("")); }

try {
  if (!(await ready(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (c) => serverLog.push(c.toString()));
    server.stderr.on("data", (c) => serverLog.push(c.toString()));
  }
  await waitForServer(URL, 20000);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.evaluate(() => window.__rht.startBattle("dustbowl", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  const ids = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const g = sim.debugSpawn("gunship", "player", { x: -4, z: 3 });
    sim.debugSpawn("interceptor", "player", { x: 0, z: 3 });
    sim.debugSpawn("bomber", "player", { x: 5, z: 3 });
    const ei = sim.debugSpawn("interceptor", "enemy", { x: -4, z: -4 }); // an enemy plane to shoot
    window.__rht.setView({ x: 0, z: 9, zoom: 0.68, pitch: 0.14, yaw: 0.12 }); // low angle to frame the flyers at altitude
    window.__rht.deselect();
    return { gunship: g.id, enemyAir: ei.id };
  });
  await delay(700);
  await page.screenshot({ path: join(OUT, "10-air-fleet.png") });

  // B5: select the gunship, target the enemy interceptor, confirm-shoot should be ENABLED.
  await page.click(`[data-select="${ids.gunship}"]`);
  await delay(150);
  await page.evaluate((id) => window.__rht.chooseBoardEntity(id), ids.enemyAir);
  await page.evaluate(() => window.__rht.setIntent("shoot"));
  await delay(300);
  const shootUi = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".btn.confirm")].find((b) => /Shoot/i.test(b.textContent || ""));
    return { text: btn?.textContent?.trim() ?? "(none)", disabled: btn?.classList.contains("disabled") ?? true };
  });
  await page.screenshot({ path: join(OUT, "11-gunship-shoot-air.png") });
  console.log("  gunship shoot-confirm vs enemy plane:", JSON.stringify(shootUi));

  const kinds = await page.evaluate(() => window.__rht.sim.entities.filter((e) => e.flying).map((e) => e.kind).sort());
  console.log("  flyers on field:", JSON.stringify(kinds));

  let ok = true;
  if (shootUi.text === "(none)" || shootUi.disabled) { console.error("FAIL: gunship can't confirm a shot at an enemy plane", shootUi); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-airfleet error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
