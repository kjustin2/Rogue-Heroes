// Verify the air transport: it loads a friendly unit (which then vanishes from the ground = aboard),
// carries it, and unloads it elsewhere (it reappears). Out: shots/transport/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5201;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "transport");
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
async function resolve(page) { await page.evaluate(() => window.__rht.endTurn()); await page.waitForFunction(() => window.__rht.sim.phase === "command" || window.__rht.sim.gameOver, null, { timeout: 8000 }).catch(() => {}); }

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

  const ids = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const t = sim.debugSpawn("transport", "player", { x: -2, z: 2 });
    const r = sim.debugSpawn("soldier", "player", { x: 0, z: 2 });
    window.__rht.setView({ x: 2, z: 6, zoom: 0.7, pitch: 0.28, yaw: 0.1 });
    window.__rht.deselect();
    return { t: t.id, r: r.id };
  });
  await delay(500);
  await page.screenshot({ path: join(OUT, "01-before-load.png") });

  // Load the soldier via the sim, resolve, then screenshot: the soldier should be aboard (hidden).
  await page.evaluate((ids) => { window.__rht.sim.select(ids.t); window.__rht.sim.queueLoad(ids.r); }, ids);
  await resolve(page);
  const loaded = await page.evaluate((ids) => {
    const r = window.__rht.sim.entity(ids.r);
    const t = window.__rht.sim.entity(ids.t);
    return { carried: r.carriedById, passengers: t.passengerIds };
  }, ids);
  await delay(500);
  await page.screenshot({ path: join(OUT, "02-loaded-aboard.png") });
  console.log("  after load:", JSON.stringify(loaded));

  // Unload far away, resolve, screenshot: the soldier reappears near the drop.
  await page.evaluate((ids) => { window.__rht.sim.select(ids.t); window.__rht.sim.queueUnload({ x: 12, z: -2 }); }, ids);
  await resolve(page);
  const dropped = await page.evaluate((ids) => {
    const r = window.__rht.sim.entity(ids.r);
    return { carried: r.carriedById, x: +r.position.x.toFixed(1), z: +r.position.z.toFixed(1) };
  }, ids);
  await page.evaluate(() => window.__rht.setView({ x: 10, z: 0, zoom: 0.7, pitch: 0.28, yaw: 0.1 }));
  await delay(500);
  await page.screenshot({ path: join(OUT, "03-unloaded.png") });
  console.log("  after unload:", JSON.stringify(dropped));

  let ok = true;
  if (loaded.carried !== ids.t || !loaded.passengers?.includes(ids.r)) { console.error("FAIL: soldier not aboard after load", loaded); ok = false; }
  if (dropped.carried || !(dropped.x > 8)) { console.error("FAIL: soldier not set down near the drop point", dropped); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-transport error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
