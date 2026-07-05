// Collision audit: on Frozen Causeway, a unit ordered across open water STOPS at the shore, while
// one ordered along a bridge CROSSES. Proves the water blocker + bridge exemption visually + by
// state. Out: shots/water/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5196;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "water");
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
  await page.evaluate(() => window.__rht.startBattle("causeway", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  // North water channel on the scaled causeway is roughly z >= 10; the NW bridge sits near x=-12.
  const ids = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const a = sim.debugSpawn("soldier", "player", { x: 2, z: 6 });   // open water ahead — should stop
    const b = sim.debugSpawn("soldier", "player", { x: -12, z: 6 }); // bridge ahead — should cross
    sim.select(a.id); sim.queueMove({ x: 2, z: 26 });
    sim.select(b.id); sim.queueMove({ x: -12, z: 26 });
    window.__rht.deselect();
    return { a: a.id, b: b.id };
  });
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" || window.__rht.sim.gameOver, null, { timeout: 8000 }).catch(() => {});

  const res = await page.evaluate((ids) => {
    const sim = window.__rht.sim;
    const a = sim.entity(ids.a), b = sim.entity(ids.b);
    window.__rht.setView({ x: -2, z: 12, zoom: 1.3, pitch: 0.72, yaw: 0.02 });
    return { aZ: +a.position.z.toFixed(2), bZ: +b.position.z.toFixed(2) };
  }, ids);
  await delay(600);
  await page.screenshot({ path: join(OUT, "01-water-block-vs-bridge.png") });
  console.log(`  swimmer stopped at z=${res.aZ} (should be < ~10, the shore); bridge unit at z=${res.bZ} (should be > 12, crossing)`);

  let ok = true;
  if (!(res.aZ < 10.5)) { console.error("FAIL: open-water unit was not stopped at the shore", res); ok = false; }
  if (!(res.bZ > 12)) { console.error("FAIL: bridge unit did not cross the water", res); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-water error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
