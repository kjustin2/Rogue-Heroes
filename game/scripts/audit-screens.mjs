import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5178;
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
  await page.waitForSelector(".topbar");
  await page.click("[data-start]");
  await page.waitForSelector(".title-screen", { state: "detached", timeout: 4000 }).catch(() => {});
  await delay(500);

  const ids = await page.evaluate(() => {
    const e = window.__rht.sim.entities;
    return {
      base: e.find((x) => x.kind === "base" && x.team === "player")?.id,
      soldier: e.find((x) => x.kind === "soldier" && x.team === "player")?.id,
      enemy: e.find((x) => x.kind === "tank" && x.team === "enemy")?.id,
    };
  });

  // 0) Mid-walk frame to sanity-check the stride animation. Zoom in on the mover.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const soldier = sim.entities.find((x) => x.kind === "soldier" && x.team === "player");
    sim.select(soldier.id);
    sim.queueMove({ x: soldier.position.x + 6, z: soldier.position.z + 1 });
    window.__rht.endTurn();
  });
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(800, 450);
    await page.mouse.wheel(0, -120);
  }
  await delay(550);
  await page.screenshot({ path: join(OUT, "audit-0-walk.png"), clip: { x: 560, y: 250, width: 680, height: 460 } });
  await page.waitForFunction(() => window.__rht.sim.phase === "command", undefined, { timeout: 14000 }).catch(() => {});
  await delay(300);
  // Reset zoom for the remaining wide shots.
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(800, 450);
    await page.mouse.wheel(0, 120);
  }
  await delay(200);

  // 1) Home Base command deck — troop deployment + upgrades.
  await page.click(`[data-select="${ids.base}"]`);
  await delay(400);
  await page.screenshot({ path: join(OUT, "audit-1-base.png") });

  // 2) Deploy a Recruit straight from the base.
  const spawnBtn = await page.$('[data-spawn="soldier"]');
  if (spawnBtn) await spawnBtn.click();
  await delay(300);
  await page.screenshot({ path: join(OUT, "audit-2-deploy.png") });

  // 3) Shoot flow — target panel + part options.
  await page.click(`[data-select="${ids.soldier}"]`);
  await delay(120);
  const shootBtn = await page.$('[data-order-action="shoot"]');
  if (shootBtn) await shootBtn.click();
  await delay(200);
  const enemyChip = await page.$(`[data-select="${ids.enemy}"]`);
  if (enemyChip) await enemyChip.click();
  await delay(300);
  await page.screenshot({ path: join(OUT, "audit-3-shoot.png") });

  // 4) Inspect-detail (the part cards that were overlapping). Reset to select first so
  // clicking the enemy enters inspect mode (not the lingering shoot mode).
  await page.evaluate(() => {
    const soldier = window.__rht.sim.entities.find((x) => x.kind === "soldier" && x.team === "player");
    window.__rht.chooseBoardEntity(soldier.id);
    const enemy = window.__rht.sim.entities.find((x) => x.kind === "tank" && x.team === "enemy");
    window.__rht.chooseBoardEntity(enemy.id);
  });
  await delay(200);
  const moreBtn = await page.$('[data-order-action="inspect-detail"]');
  if (moreBtn) await moreBtn.click();
  await delay(300);
  await page.screenshot({ path: join(OUT, "audit-4-inspect.png") });

  // 5) Clean battlefield shot to inspect terrain/object overlaps.
  await page.evaluate(() => window.__rht.deselect());
  await delay(200);
  await page.screenshot({ path: join(OUT, "audit-5-scene.png") });

  console.log("Audit screenshots saved to shots/audit-*.png");
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
