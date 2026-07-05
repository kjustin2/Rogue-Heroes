// Verify every enlarged map frames fully, shadows cover the arena, and cover density looks right.
// Zooms out and captures an overview of each map. Out: shots/maps/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5195;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "maps");
mkdirSync(OUT, { recursive: true });
const MAPS = ["dustbowl", "causeway", "verdant", "karak", "crossfire", "ironworks"];
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

  for (const id of MAPS) {
    await page.evaluate((m) => window.__rht.startBattle(m, "destroy", "normal"), id);
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    const dims = await page.evaluate(() => {
      const b = window.__rht.sim.mapDef.terrain.bounds;
      const sz = window.__rht.sim.mapDef.size;
      // Pull the camera to the map centre and zoom fully out for an overview.
      window.__rht.setView({ x: 0, z: 0, zoom: 2.6, pitch: 0.62, yaw: 0.02 });
      return { w: (b.maxX - b.minX).toFixed(1), d: (b.maxZ - b.minZ).toFixed(1), size: sz };
    });
    await page.evaluate(() => window.__rht.deselect());
    await delay(600);
    await page.screenshot({ path: join(OUT, `${id}.png`) });
    console.log(`  ${id}: ${dims.w}x${dims.d} (${dims.size})`);
  }

  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-maps error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
