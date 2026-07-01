// Verifies a battle in progress is auto-saved when the page is hidden (app/tab close), and
// that the save persists (saves are never silently dropped — that's the whole point).
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5189;
const URL = `http://127.0.0.1:${PORT}`;
const SAVE_KEY = "rht.savedBattle.v1";

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright");
  for (const dir of readdirSync(base)) if (dir.startsWith("chromium-")) return join(base, dir, "chrome-win", "chrome.exe");
  throw new Error("No Playwright Chromium found");
}
async function ready(u) { try { await fetch(u); return true; } catch { return false; } }

let server = null, browser = null;
try {
  if (!(await ready(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  }
  for (let i = 0; i < 100 && !(await ready(URL)); i++) await delay(200);

  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(`${URL}/?lowfx=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");

  // Start a battle through the menu.
  await page.click('[data-menu="play"]');
  await page.waitForSelector('[data-map="ironworks"]');
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht && window.__rht.sim.phase === "command");

  const problems = [];

  // No save should exist for a fresh, unsaved battle.
  const before = await page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);

  // Simulate the app/tab closing mid-battle.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const afterHide = await page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);
  if (!afterHide) problems.push("pagehide did NOT auto-save the in-progress battle");

  // The save must round-trip back into a resumable battle.
  const restores = await page.evaluate((k) => {
    const probe = new window.__rht.sim.constructor();
    return probe.restore(localStorage.getItem(k));
  }, SAVE_KEY);
  if (!restores) problems.push("auto-saved battle does not restore");

  console.log(JSON.stringify({ before, savedOnHide: Boolean(afterHide), restores }));
  if (problems.length) { console.error("FAIL:\n - " + problems.join("\n - ")); process.exitCode = 1; }
  else console.log("PASS: pagehide auto-saves an active, restorable battle.");
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
