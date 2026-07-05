// Verify the gunship bomb: the deck/confirm read "Bomb" (not grenade), and the bomb drops STRAIGHT
// DOWN beneath the aircraft (visible mid-fall, no vanish) and detonates. Out: shots/bomb/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5198;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "bomb");
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

  const gid = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const g = sim.debugSpawn("gunship", "player", { x: 0, z: 0 });
    sim.debugSpawn("soldier", "enemy", { x: 0, z: 0.4 }); // directly beneath the plane
    window.__rht.setView({ x: 2, z: 2, zoom: 0.72, pitch: 0.32, yaw: 0.1 });
    return g.id;
  });

  // Select the gunship via a real roster click (refreshes the HUD DOM), then arm Bomb.
  await page.click(`[data-select="${gid}"]`);
  await delay(200);
  const deckText = await page.evaluate(() => document.querySelector('[data-order-action="grenade"]')?.textContent ?? "");
  await page.click('[data-order-action="grenade"]');
  await delay(250);
  const confirmText = await page.evaluate(() => [...document.querySelectorAll(".btn.confirm")].map((b) => b.textContent?.trim()).join(" | "));
  await page.screenshot({ path: join(OUT, "01-bomb-armed.png") });
  console.log("  deck:", JSON.stringify(deckText.trim()), "| confirm:", JSON.stringify(confirmText));

  // Drop it and catch the bomb mid-fall (should be near the plane's XZ, descending).
  await page.evaluate(() => window.__rht.queueBombDrop());
  await page.evaluate(() => window.__rht.endTurn());
  let caught = null;
  for (let i = 0; i < 80 && !caught; i += 1) {
    caught = await page.evaluate(() => {
      const p = window.__rht.sim.projectiles.find((pr) => pr.attackMode === "grenade");
      return p ? { x: +p.position.x.toFixed(2), z: +p.position.z.toFixed(2), h: +p.height.toFixed(2) } : null;
    });
    if (caught) { await page.screenshot({ path: join(OUT, "02-bomb-falling.png") }); break; }
    await delay(30);
  }
  console.log("  bomb mid-fall:", JSON.stringify(caught));

  let ok = true;
  if (!/Bomb/.test(deckText) || !/Bomb/.test(confirmText)) { console.error("FAIL: label still says grenade", { deckText, confirmText }); ok = false; }
  if (!caught) { console.error("FAIL: never caught the bomb in flight"); ok = false; }
  else if (Math.hypot(caught.x, caught.z) > 2) { console.error("FAIL: bomb not dropping under the plane (x0,z0)", caught); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-bomb error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
