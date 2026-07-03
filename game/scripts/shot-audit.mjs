// Final-audit evidence shots: every system added in the Campaign 2.0 batch, staged via
// the __rht debug seam and captured for visual review.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5187;
const URL = `http://127.0.0.1:${PORT}`;
mkdirSync("shots/audit", { recursive: true });

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
  return join(base, dir, "chrome-win", "chrome.exe");
}

let server = null;
let browser = null;
try {
  const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], { cwd: process.cwd(), stdio: "ignore" });
  const until = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(URL)).ok) break; } catch {}
    if (Date.now() > until) throw new Error("no server");
    await delay(200);
  }
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");

  const shoot = async (name) => page.screenshot({ path: `shots/audit/${name}.png` });
  const pin = async (view) => { await page.evaluate((v) => window.__rht.setView(v), view); await delay(300); };
  const battle = async (map, mode) => {
    await page.evaluate(({ map, mode }) => window.__rht.startBattle(map, mode, "normal"), { map, mode });
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    await delay(1800); // GLBs
  };

  // 1. Overwatch ring + amber eye — real flow: queue overwatch, resolve, back to command.
  await battle("dustbowl", "destroy");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const u = sim.debugSpawn("soldier", "player", { x: -2, z: 0 });
    sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });
    sim.debugSelect(u.id);
    sim.queueOverwatch();
    window.__rht.endTurn();
  });
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 });
  await delay(3200); // let the TURN banner and toasts age out
  await pin({ x: -1, z: 0, zoom: 0.75, pitch: 0.55, yaw: 0.3 });
  await shoot("01-overwatch");

  // 2. Burn zones + mines + wreck + scorch (direct state injection is fine for visuals).
  await battle("dustbowl", "destroy");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.burnZones.push({ id: "burn-a", x: 1, z: -1.5, radius: 1.6, turnsLeft: 2 });
    sim.mines.push({ id: "mine-a", x: -1.5, z: 1.5, team: "player" }, { id: "mine-b", x: -0.5, z: 2.5, team: "player" });
    const victim = sim.debugSpawn("tank", "enemy", { x: 2.5, z: 1.5 });
    for (const part of victim.parts) sim.debugDamage(victim.id, part.id, 999);
    window.__rht.deselect();
  });
  await pin({ x: 0.5, z: 0.5, zoom: 0.72, pitch: 0.6, yaw: 0.25 });
  await shoot("02-burn-mines-wreck");

  // 3. Depot (capturable neutral, dustbowl flanks at ±13,8): park a soldier on the pad
  // and run a turn so the capture tick flips the holder to player colors.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugSpawn("soldier", "player", { x: -12.2, z: 8 });
    window.__rht.endTurn();
  });
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 });
  await delay(3200);
  await pin({ x: -12.5, z: 7.5, zoom: 0.95, pitch: 0.5, yaw: 0.25 });
  await shoot("03-depot-forecast");

  // 4. Boss bar (elite enemy with bossName) — top-of-screen HP bar.
  await battle("ironworks", "destroy");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugSpawn("tank", "enemy", { x: 4, z: 0 }, { elite: true, bossName: "CORE WARDEN" });
    window.__rht.deselect();
  });
  await pin({ x: 3, z: 0, zoom: 0.7, pitch: 0.55, yaw: 0.3 });
  await delay(1500);
  await shoot("04-boss-bar");

  // 5. Domination sectors.
  await battle("crossfire", "domination");
  await page.evaluate(() => window.__rht.deselect());
  await pin({ x: 0, z: 0, zoom: 0.45, pitch: 0.7, yaw: 0.2 });
  await shoot("05-domination");

  // 6. Survival mode chip.
  await battle("dustbowl", "survival");
  await page.evaluate(() => window.__rht.deselect());
  await pin({ x: 0, z: 0, zoom: 0.5, pitch: 0.6, yaw: 0.25 });
  await shoot("06-survival");

  // 7. Campaign operation map (branch rail, roster, requisition).
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="campaign"]');
  await delay(400);
  await shoot("07-campaign-map");
  await page.keyboard.press("Escape");
  await delay(300);

  // 8. Commander profile in the Armory.
  await page.click('[data-menu="armory"]');
  await delay(400);
  await shoot("08-armory-commander");
  // Scroll to the commander titles/emblems below the accents grid.
  await page.evaluate(() => {
    const panel = document.querySelector(".menu-screen .menu-panel, .menu-screen");
    if (panel) panel.scrollTop = panel.scrollHeight;
  });
  await delay(250);
  await shoot("08b-armory-titles");
  console.log("OK -> shots/audit");
} finally {
  await browser?.close();
  server?.kill();
}
