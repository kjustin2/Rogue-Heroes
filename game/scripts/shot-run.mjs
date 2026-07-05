// Verify the Skirmish Run (roguelike ladder): the intro screen, a sector battle, the between-sector
// carry-over overlay (veterans + banked cash), and the final Run Complete screen. Drives the real
// end-state loop via debugSetPhase("victory") after seeding a couple of survivors each sector so the
// veteran roster visibly grows. Out: shots/run/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5190;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "run");
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

// Seed two named player survivors, then force a victory and let the real loop raise the overlay.
async function winSector(page) {
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 2000);
    sim.debugSpawn("soldier", "player", { x: -3, z: 2 });
    sim.debugSpawn("tank", "player", { x: -4, z: -2 });
    window.__rht.deselect();
    sim.debugSetPhase("victory");
  });
  await page.waitForSelector(".campaign-overlay", { timeout: 8000 });
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
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  // Clear any stale run save so we always start fresh.
  await page.evaluate(() => localStorage.removeItem("rht.run.v1"));

  // 1) Skirmish Run intro screen.
  await page.click('[data-menu="run"]');
  await page.waitForSelector(".menu-heading");
  await delay(250);
  await page.screenshot({ path: join(OUT, "01-run-intro.png") });
  console.log("  shot 01-run-intro.png");

  // 2) Begin the run → sector 1 battle.
  await page.click('[data-new]');
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 12000 });
  await delay(600);
  await page.screenshot({ path: join(OUT, "02-sector-1.png") });
  console.log("  shot 02-sector-1.png");

  // 3) Win sectors 1–3 → between-sector carry-over overlays (veterans accumulate).
  for (let s = 1; s <= 3; s += 1) {
    await winSector(page);
    await delay(400);
    await page.screenshot({ path: join(OUT, `0${s + 2}-sector-${s}-cleared.png`) });
    console.log(`  shot 0${s + 2}-sector-${s}-cleared.png`);
    await page.click('[data-next]'); // Deploy next sector
    await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 12000 });
    await delay(400);
  }

  // 4) Win the final sector → Run Complete.
  await winSector(page);
  await delay(400);
  await page.screenshot({ path: join(OUT, "06-run-complete.png") });
  console.log("  shot 06-run-complete.png");

  const state = await page.evaluate(() => {
    const heading = document.querySelector(".campaign-end__kicker")?.textContent ?? "";
    const raw = localStorage.getItem("rht.run.v1");
    return { heading, run: raw ? JSON.parse(raw) : null };
  });
  console.log("  end state:", JSON.stringify(state));

  let ok = true;
  if (!/Run Complete/i.test(state.heading)) { console.error("FAIL: final overlay is not Run Complete:", state.heading); ok = false; }
  if (state.run?.active !== false) { console.error("FAIL: run still active after completion", state.run); ok = false; }
  if (!(state.run && state.run.index >= 4)) { console.error("FAIL: run did not reach the last sector", state.run); ok = false; }
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-run error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
