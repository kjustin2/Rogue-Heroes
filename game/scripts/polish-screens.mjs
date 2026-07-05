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
  await page.waitForSelector(".main-menu");
  await delay(900); // let fonts + the first frames settle
  await page.screenshot({ path: join(OUT, "polish-1-title.png") });

  // Settings screen (a canonical review shot).
  await page.click('[data-menu="settings"]');
  await page.waitForSelector('[data-set="skin"]');
  await delay(400);
  await page.screenshot({ path: join(OUT, "polish-2-settings.png") });

  // Back to the menu, then into a skirmish (menu → Skirmish → pick map → Deploy).
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-start]");
  await page.click('[data-map="ironworks"]');
  await delay(150);
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 12000 });
  await delay(700);

  // Populate the field so the action shots show real units, then frame the home base deck.
  const ids = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 3000);
    sim.debugSpawn("soldier", "player", { x: -3, z: 3 });
    const tank = sim.debugSpawn("tank", "player", { x: -5, z: -1 });
    sim.debugSpawn("gunship", "player", { x: -2, z: 6 });
    sim.debugSpawn("soldier", "enemy", { x: 4, z: 2 });
    sim.debugSpawn("tank", "enemy", { x: 6, z: -2 });
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    window.__rht.deselect();
    return { tank: tank.id, base: base ? base.id : null };
  });
  if (ids.base) { await page.click(`[data-select="${ids.base}"]`); await delay(500); }
  await page.screenshot({ path: join(OUT, "polish-3-battle.png") });

  // Select a tank and arm Shoot to show the unit command deck + range.
  if (ids.tank) {
    await page.click(`[data-select="${ids.tank}"]`);
    await delay(150);
    const shootBtn = await page.$('[data-order-action="shoot"]');
    if (shootBtn) await shootBtn.click();
    await delay(350);
  }
  await page.screenshot({ path: join(OUT, "polish-4-command.png") });

  // Pause menu (via the HUD Menu button — deterministic in headless where Escape sequencing
  // depends on selection/intent state).
  await page.evaluate(() => window.__rht.deselect());
  await delay(100);
  await page.click('[data-command="open-menu"]');
  await page.waitForSelector(".pause-overlay .pause-card");
  await delay(300);
  await page.screenshot({ path: join(OUT, "polish-5-pause.png") });

  // Force a victory to capture the end state (skirmish shows a points toast over the field).
  await page.evaluate(() => {
    document.querySelectorAll(".pause-overlay").forEach((el) => el.remove());
    window.__rht.deselect();
    window.__rht.sim.debugSetPhase("victory");
  });
  await delay(2200); // kill-cam + toast settle
  await page.screenshot({ path: join(OUT, "polish-6-victory.png") });

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
