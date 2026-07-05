// Verify the doctrine-mastery-gated Winter skin toggle (#19): locked "🔒 0/3" for a fresh
// commander, unlocked once 3 mastery stars are earned. Out: shots/cosmetic/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5192;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "cosmetic");
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

async function openSettings(page) {
  await page.click('[data-menu="settings"]');
  await page.waitForSelector('[data-set="skin"]');
  await delay(200);
}
async function skinLabel(page) {
  return page.evaluate(() => document.querySelector('[data-set="skin"]')?.textContent?.trim());
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
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");

  // 1) Fresh commander → locked.
  await page.evaluate(() => localStorage.removeItem("rht.commander.v1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await openSettings(page);
  const locked = await skinLabel(page);
  await page.screenshot({ path: join(OUT, "01-skin-locked.png") });
  console.log("  locked label:", JSON.stringify(locked));

  // 2) Seed 3 mastery stars (one doctrine researched 10× → tier III) → unlocked.
  await page.evaluate(() => localStorage.setItem("rht.commander.v1", JSON.stringify({ battles: 4, wins: 4, losses: 0, kills: 20, killsByKind: {}, doctrineUse: { recon: 10 }, medals: [] })));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await openSettings(page);
  const unlocked = await skinLabel(page);
  await page.screenshot({ path: join(OUT, "02-skin-unlocked.png") });
  console.log("  unlocked label:", JSON.stringify(unlocked));

  let ok = true;
  if (!/0\/3/.test(locked ?? "")) { console.error("FAIL: fresh commander skin not locked at 0/3:", locked); ok = false; }
  if (!/Standard|Winter/.test(unlocked ?? "")) { console.error("FAIL: 3-star commander skin still locked:", unlocked); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-cosmetic error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
