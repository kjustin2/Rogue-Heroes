import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5177;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });

const serverLog = [];
let server = null;
let browser = null;

try {
  if (!(await isServerReady(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
    server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  }

  await waitForServer(URL, 20000);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })).newPage();

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".title-screen");
  await delay(900); // let fonts + the first frames settle
  await page.screenshot({ path: join(OUT, "polish-1-title.png") });

  // Enter the battle and select the home base to show its command deck (deploy + upgrades).
  await page.click("[data-start]");
  await delay(700);
  const baseId = await page.evaluate(() => {
    const b = window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player");
    return b ? b.id : null;
  });
  if (baseId) {
    await page.click(`[data-select="${baseId}"]`);
    await delay(500);
  }
  await page.screenshot({ path: join(OUT, "polish-2-battle.png") });

  // Select a squad unit through the roster (proper flow) and arm Shoot to show the command deck.
  const tankId = await page.evaluate(() => {
    const unit = window.__rht.sim.entities.find((e) => e.team === "player" && e.kind === "tank");
    return unit ? unit.id : null;
  });
  if (tankId) {
    await page.click(`[data-select="${tankId}"]`);
    await delay(150);
    const shootBtn = await page.$('[data-order-action="shoot"]');
    if (shootBtn) await shootBtn.click();
    await delay(350);
  }
  await page.screenshot({ path: join(OUT, "polish-3-command.png") });

  // Force a victory to capture the end screen.
  await page.evaluate(() => { window.__rht.sim.phase = "victory"; });
  await delay(400);
  await page.screenshot({ path: join(OUT, "polish-4-victory.png") });

  console.log("Polish screenshots saved to shots/polish-*.png");
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // starting
    }
    await delay(250);
  }
  throw new Error(`Server did not start at ${url}\n${serverLog.join("")}`);
}

async function isServerReady(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const root = join(local, "ms-playwright");
  if (!existsSync(root)) throw new Error(`Missing Playwright browser cache: ${root}`);
  const matches = readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => join(root, name, "chrome-win64", "chrome.exe"))
    .filter((path) => existsSync(path))
    .sort();
  if (!matches.length) throw new Error(`No cached Chromium executable under ${root}`);
  return matches[matches.length - 1];
}
