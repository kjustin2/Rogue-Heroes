// Verify pooled projectile trails still render: stage a shootout, end the turn, and grab a frame
// mid-resolve while tracers are in flight. Out: shots/trail/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5194;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "trail");
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
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  // Line up several player shooters against enemies in range, queue a volley, then resolve.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    for (let i = 0; i < 4; i += 1) {
      const s = sim.debugSpawn("soldier", "player", { x: -3, z: -3 + i * 2 });
      const e = sim.debugSpawn("soldier", "enemy", { x: 4, z: -3 + i * 2 });
      window.__rht.chooseBoardEntity(s.id);
      window.__rht.setIntent("shoot");
      window.__rht.queueShootAt(e.position);
    }
    window.__rht.deselect();
    window.__rht.setView({ x: 0, z: 0, zoom: 0.85, pitch: 0.5, yaw: 0.05 });
  });
  await page.evaluate(() => window.__rht.endTurn());

  // Poll fast for a frame that has tracers in flight, and shoot it.
  let captured = false;
  for (let i = 0; i < 60 && !captured; i += 1) {
    const n = await page.evaluate(() => window.__rht.sim.projectiles.length);
    if (n > 0) {
      await page.screenshot({ path: join(OUT, "01-trails.png") });
      captured = true;
      console.log(`  captured with ${n} projectiles in flight`);
    }
    await delay(40);
  }

  if (!captured) { console.error("FAIL: never caught a projectile in flight"); process.exitCode = 1; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); process.exitCode = 1; }
  if (!process.exitCode) console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-trail error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
