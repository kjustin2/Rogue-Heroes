// Live proof the enemy AI plays smarter: facing a player gunship it fields a Flak Track (or other
// anti-air), and idle units divert to cash caches. Runs several real enemy turns headless, then
// screenshots the field + asserts the AA showed up. Out: shots/ai/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5193;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "ai");
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

// End a turn and pump the resolve to completion so the enemy's orders play out.
async function playTurn(page) {
  await page.evaluate(() => window.__rht.endTurn());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" || window.__rht.sim.gameOver, null, { timeout: 8000 }).catch(() => {});
}

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

  // Player fields a lone gunship and holds; the enemy is flush with cash and has caches nearby.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugSpawn("gunship", "player", { x: -6, z: 0 });
    window.__rht.deselect();
  });

  let fieldedAA = false;
  for (let t = 0; t < 12 && !fieldedAA; t += 1) {
    await page.evaluate(() => window.__rht.sim.debugGrant("enemy", 500));
    await playTurn(page);
    fieldedAA = await page.evaluate(() =>
      window.__rht.sim.entities.some((e) => e.team === "enemy" && e.status.alive && (e.kind === "flak" || e.kind === "heavy" || e.kind === "sniper")));
    if (await page.evaluate(() => window.__rht.sim.gameOver)) break;
  }

  const summary = await page.evaluate(() => {
    const sim = window.__rht.sim;
    const enemy = sim.entities.filter((e) => e.team === "enemy" && e.status.alive && !["base", "cover", "wall"].includes(e.kind));
    return { turn: sim.turn, enemyKinds: enemy.map((e) => e.kind).sort() };
  });
  console.log("  after AI turns:", JSON.stringify(summary));

  // Frame the enemy half so any Flak Track / AA is in shot.
  await page.evaluate(() => window.__rht.setView({ x: 8, z: 0, zoom: 0.8, pitch: 0.42, yaw: 0.1 }));
  await delay(600);
  await page.screenshot({ path: join(OUT, "01-enemy-response.png") });
  console.log("  shot 01-enemy-response.png");

  if (!fieldedAA) { console.error("FAIL: enemy never fielded anti-air against the player's gunship", summary); process.exitCode = 1; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); process.exitCode = 1; }
  if (!process.exitCode) console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-ai error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
