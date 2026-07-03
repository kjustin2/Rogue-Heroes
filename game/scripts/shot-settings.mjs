// Evidence shots for task 21: settings Controls/rebind rows + toggles, winter skin
// pack in battle, and the high-contrast (colorblind) team palette.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5189;
const URL = `http://127.0.0.1:${PORT}`;
mkdirSync("shots/settings", { recursive: true });

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

  // 1. Settings screen — scroll to the Controls section, arm a rebind button.
  await page.click('[data-menu="settings"]');
  await page.waitForSelector(".settings-row--head");
  await delay(700); // panel fade-in
  await page.screenshot({ path: "shots/settings/01-settings-top.png" });
  await page.locator(".settings-row--head").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "shots/settings/02-settings-controls.png" });
  await page.click('[data-rebind="overwatch"]');
  await delay(150);
  await page.screenshot({ path: "shots/settings/03-rebind-listening.png" });
  await page.keyboard.press("KeyP"); // capture P for overwatch
  await delay(200);
  await page.locator('[data-rebind="overwatch"]').scrollIntoViewIfNeeded();
  await delay(150);
  await page.screenshot({ path: "shots/settings/04-rebind-applied.png" });
  const applied = await page.locator('[data-rebind="overwatch"]').textContent();
  if (applied?.trim() !== "P") throw new Error(`rebind failed: overwatch shows "${applied}"`);

  // 2. Battle staging helper — line up vehicles + structures so skins/palette read.
  async function stageBattle() {
    await page.evaluate(() => window.__rht.startBattle("dustbowl", "destroy", "normal"));
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    await page.evaluate(() => {
      const sim = window.__rht.sim;
      for (const [kind, x, z] of [["tank", -4, -2], ["apc", -4, 1], ["artillery", -6, 3]]) sim.debugSpawn(kind, "player", { x, z });
      for (const [kind, x, z] of [["tank", 4, -1], ["apc", 4, 2]]) sim.debugSpawn(kind, "enemy", { x, z });
      window.__rht.deselect(); // close the base deck so the field is visible
    });
    await delay(2500); // let GLBs stream in
  }
  async function pinAndShoot(path) {
    await page.evaluate(() => window.__rht.setView({ x: 0, z: 0, zoom: 0.55, pitch: 0.5, yaw: 0.35 }));
    await delay(300);
    await page.screenshot({ path });
  }

  // 3. Standard vs winter skin.
  await stageBattle();
  await pinAndShoot("shots/settings/05-skin-standard.png");
  await page.evaluate(() => window.__rht.setModelSkin("winter"));
  await delay(3500); // winter GLBs load + rebuild
  await pinAndShoot("shots/settings/06-skin-winter.png");

  // 4. High-contrast team palette on the same scene.
  await page.evaluate(() => window.__rht.setHighContrastTeams(true));
  await delay(600);
  await pinAndShoot("shots/settings/07-high-contrast.png");
  console.log("OK -> shots/settings");
} finally {
  await browser?.close();
  server?.kill();
}
