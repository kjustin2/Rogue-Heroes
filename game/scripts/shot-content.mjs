// Verify the R2 content pass: map-select size badges, run-over cash caches, and the new
// container/bunker objects on the (now larger) Dust Bowl. Out: shots/content/*.png
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5188;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "content");
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
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");

  // 1) Map select — should show Small/Medium/Large badges on the map cards.
  await page.click('[data-menu="play"]');
  await page.waitForSelector(".map-card");
  await delay(300);
  await page.screenshot({ path: join(OUT, "01-map-select.png") });
  console.log("  shot 01-map-select.png");

  // 2) Dust Bowl (now LARGE): cash caches + a bunker + a container in view.
  await page.evaluate(() => window.__rht.startBattle("dustbowl", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.mapDef.id === "dustbowl" && window.__rht.sim.phase === "command");
  const info = await page.evaluate(() => {
    const sim = window.__rht.sim;
    return {
      pickups: sim.pickups.length,
      firstPickup: sim.pickups[0] ?? null,
      hasBunker: sim.entities.some((e) => e.coverKind === "bunker"),
      hasContainer: sim.entities.some((e) => e.coverKind === "container"),
      bounds: sim.mapDef.terrain.bounds,
    };
  });
  console.log("  dustbowl:", JSON.stringify(info));
  // Frame on a cache so the gold diamond is in view (fallback to center).
  const focus = info.firstPickup ?? { x: 0, z: 0 };
  await page.evaluate((f) => window.__rht.setView({ x: f.x, z: f.z, zoom: 0.62, pitch: 0.52, yaw: 0.25 }), focus);
  await delay(500);
  await page.screenshot({ path: join(OUT, "02-dustbowl-cache.png") });
  console.log("  shot 02-dustbowl-cache.png");

  // 3) Wide shot of the larger map to read the expanded scale + scattered objects.
  await page.evaluate(() => window.__rht.setView({ x: 0, z: 0, zoom: 1.5, pitch: 0.72, yaw: 0.2 }));
  await delay(400);
  await page.screenshot({ path: join(OUT, "03-dustbowl-wide.png") });
  console.log("  shot 03-dustbowl-wide.png");

  if (!info.pickups) { console.error("FAIL: no cash caches placed"); process.exitCode = 1; }
  if (!info.hasBunker || !info.hasContainer) console.error("WARN: bunker/container not both present (scatter is seeded)");
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-content error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
