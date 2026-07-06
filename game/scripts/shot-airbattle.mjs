// Verify air-to-air combat RESOLVES: a gunship guns an enemy interceptor, the tracer connects (stays
// visible in flight), and the interceptor takes damage. Out: shots/air/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5203;
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

  const before = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const g = sim.debugSpawn("gunship", "player", { x: -3, z: 0 });
    const e = sim.debugSpawn("interceptor", "enemy", { x: 6, z: 0 });
    // Immobilise the enemy fighter so it holds for a clean shot.
    // (rotor/wing is its mobility part.)
    const wing = e.parts.find((p) => p.role === "mobility");
    if (wing) e.parts.forEach((p) => { if (p.role === "mobility") p.hp = 0; });
    sim.select(g.id);
    sim.queueShoot(e.id);
    window.__rht.setView({ x: 1, z: 4, zoom: 0.66, pitch: 0.2, yaw: 0.08 });
    return { gun: g.id, foe: e.id, foeHp: e.parts.reduce((s, p) => s + p.hp, 0) };
  });
  await page.evaluate(() => window.__rht.endTurn());

  // Catch the tracer in flight (proves it stays visible en route to an airborne target).
  let inFlight = false;
  for (let i = 0; i < 60 && !inFlight; i += 1) {
    inFlight = await page.evaluate(() => window.__rht.sim.projectiles.length > 0);
    if (inFlight) { await page.screenshot({ path: join(OUT, "20-air-to-air-tracer.png") }); break; }
    await delay(25);
  }
  await page.waitForFunction(() => window.__rht.sim.phase === "command" || window.__rht.sim.gameOver, null, { timeout: 8000 }).catch(() => {});
  const after = await page.evaluate((foe) => {
    const e = window.__rht.sim.entity(foe);
    return e ? e.parts.reduce((s, p) => s + p.hp, 0) : 0;
  }, before.foe);
  await page.screenshot({ path: join(OUT, "21-air-to-air-after.png") });
  console.log(`  tracer in flight: ${inFlight} | interceptor hp ${before.foeHp} -> ${after}`);

  let ok = true;
  if (!inFlight) { console.error("FAIL: no air-to-air tracer observed in flight"); ok = false; }
  if (!(after < before.foeHp)) { console.error("FAIL: the gunship's round did not damage the enemy interceptor", { before: before.foeHp, after }); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-airbattle error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
