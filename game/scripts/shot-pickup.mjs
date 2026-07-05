// Verify a ground cash cache is clickable and reports its payout. Places a known cache, looks
// straight down at it, clicks it, and checks the toast. Out: shots/pickup/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5197;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "pickup");
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
  await page.evaluate(() => window.__rht.startBattle("verdant", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  // Drop a known cache and look straight down at it so it lands near screen centre.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.pickups.length = 0;
    sim.pickups.push({ id: "probe-cache", x: 0, z: 0, amount: 75 });
    window.__rht.setView({ x: 0, z: 0, zoom: 0.72, pitch: 1.25, yaw: 0 });
    window.__rht.deselect();
  });
  await delay(400);

  // Real click through the raycast: sweep a few points near centre to land on the coin/disc.
  let toast = "";
  for (const [dx, dy] of [[0, 0], [0, -30], [0, 20], [-20, 0], [20, 0]]) {
    await page.mouse.click(800 + dx, 450 + dy);
    await delay(120);
    toast = await page.evaluate(() => [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));
    if (/Field cache/i.test(toast)) break;
  }
  await delay(150);
  await page.screenshot({ path: join(OUT, "01-cache-clicked.png") });
  console.log("  toast:", JSON.stringify(toast));

  let ok = true;
  if (!/Field cache/i.test(toast) || !/\$75/.test(toast)) { console.error("FAIL: clicking the cache did not show its payout toast", toast); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-pickup error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
