// Verify debug mode: launched with ?debug, Settings shows a Debug section and Infinite Money keeps
// the treasury topped up in battle; without ?debug the section is absent. Out: shots/debug/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5202;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "debug");
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
async function hasDebugSection(page) { return page.evaluate(() => !!document.querySelector('[data-set="debug-money"]')); }

try {
  if (!(await ready(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (c) => serverLog.push(c.toString()));
    server.stderr.on("data", (c) => serverLog.push(c.toString()));
  }
  await waitForServer(URL, 20000);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const errors = [];

  // --- With ?debug: Debug section present, infinite money works ---
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(`${URL}?debug`, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="settings"]');
  await page.waitForSelector('[data-set="skin"]');
  await delay(300);
  const withFlag = await hasDebugSection(page);
  await page.click('[data-set="debug-money"]'); // turn Infinite money ON
  await delay(150);
  await page.screenshot({ path: join(OUT, "01-debug-settings.png") });

  // Start a battle and let a frame or two top up the money.
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");
  await delay(400);
  const money = await page.evaluate(() => window.__rht.sim.money("player"));
  await ctx.close();

  // --- Without ?debug: Debug section absent ---
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page2 = await ctx2.newPage();
  await page2.goto(URL, { waitUntil: "networkidle" });
  await page2.waitForSelector(".main-menu");
  await page2.click('[data-menu="settings"]');
  await page2.waitForSelector('[data-set="skin"]');
  await delay(200);
  const withoutFlag = await hasDebugSection(page2);
  await ctx2.close();

  console.log(`  debug section: withFlag=${withFlag} withoutFlag=${withoutFlag} | money after infinite-money toggle=${money}`);

  let ok = true;
  if (!withFlag) { console.error("FAIL: Debug section missing when launched with ?debug"); ok = false; }
  if (withoutFlag) { console.error("FAIL: Debug section shown WITHOUT ?debug"); ok = false; }
  if (!(money > 90000)) { console.error("FAIL: Infinite money didn't top up the treasury", money); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-debug error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
