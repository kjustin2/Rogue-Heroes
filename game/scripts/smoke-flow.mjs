import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5175;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });

const serverLog = [];
let server = null;
let browser = null;

try {
  if (!(await isServerReady(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
    server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  }

  await waitForServer(URL, 20000);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".topbar");
  await assertCanvasPainted(page, "flow command");

  const queued = await page.evaluate(() => {
    const api = window.__rht;
    const sim = api.sim;

    api.reset();
    for (const entity of sim.entities) {
      if (entity.team === "neutral") {
        entity.position.x = 0;
        entity.position.z = 8;
      }
    }

    const placements = new Map([
      ["p-tank-1", { x: -5, z: 0 }],
      ["p-soldier-1", { x: -5, z: -2.4 }],
      ["p-soldier-2", { x: -5, z: 2.4 }],
      ["e-tank-1", { x: 1.2, z: 0 }],
      ["e-soldier-1", { x: 1.2, z: -2.4 }],
      ["e-base-1", { x: 1.2, z: 2.4 }],
    ]);

    for (const [id, position] of placements) {
      const entity = sim.entity(id);
      entity.position.x = position.x;
      entity.position.z = position.z;
    }

    for (const enemy of sim.entities.filter((entity) => entity.team === "enemy")) {
      const critical = enemy.parts.find((part) => part.critical);
      critical.hp = Math.min(critical.hp, 10);
    }

    sim.select("p-tank-1");
    sim.queueShootPart("e-tank-1", "hull");
    sim.select("p-soldier-1");
    sim.queueShootPart("e-soldier-1", "head");
    sim.select("p-soldier-2");
    sim.queueShootPart("e-base-1", "core");
    api.endTurn();

    return sim.orders
      .filter((order) => order.actorId.startsWith("p-"))
      .map((order) => ({ actorId: order.actorId, targetId: order.targetId, kind: order.kind }));
  });

  if (queued.length !== 3) throw new Error(`Expected 3 player orders, got ${JSON.stringify(queued)}`);

  await page.waitForTimeout(550);
  const resolveState = await page.evaluate(() => ({
    phase: window.__rht.sim.phase,
    projectiles: window.__rht.sim.projectiles.length,
    orders: window.__rht.sim.orders.length,
  }));
  if (resolveState.phase !== "resolve" || resolveState.projectiles < 1 || resolveState.orders < 3) {
    throw new Error(`Expected active simultaneous resolve, got ${JSON.stringify(resolveState)}`);
  }
  await assertCanvasPainted(page, "flow resolve");
  await page.screenshot({ path: join(OUT, "7-flow-resolve.png") });

  await page.waitForFunction(() => window.__rht.sim.phase === "victory", undefined, { timeout: 6000 });
  await assertCanvasPainted(page, "flow victory");
  await page.screenshot({ path: join(OUT, "8-flow-victory.png") });

  const victoryState = await page.evaluate(() => ({
    phase: window.__rht.sim.phase,
    livingEnemies: window.__rht.sim.living("enemy").map((entity) => entity.id),
    log: window.__rht.sim.log.slice(),
  }));
  if (victoryState.phase !== "victory") throw new Error(`Expected victory, got ${victoryState.phase}`);
  if (victoryState.livingEnemies.length) throw new Error(`Enemies still alive: ${victoryState.livingEnemies.join(", ")}`);

  await page.locator('[data-command="reset"]').click();
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1);
  const resetState = await page.evaluate(() => ({
    phase: window.__rht.sim.phase,
    turn: window.__rht.sim.turn,
    livingEnemies: window.__rht.sim.living("enemy").length,
    livingPlayers: window.__rht.sim.living("player").length,
  }));
  if (resetState.livingEnemies !== 3 || resetState.livingPlayers !== 3) {
    throw new Error(`Reset did not restore both squads: ${JSON.stringify(resetState)}`);
  }

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  console.log(`Flow passed: ${queued.length} orders, victory reached, reset restored ${resetState.livingPlayers}v${resetState.livingEnemies}`);
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
      // server still starting
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

async function assertCanvasPainted(page, label) {
  const sample = await page.evaluate(() => {
    const canvas = document.getElementById("game");
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: "missing canvas" };
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { ok: false, reason: "missing webgl context" };
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const size = 18;
    const x = Math.max(0, Math.floor(width / 2 - size / 2));
    const y = Math.max(0, Math.floor(height / 2 - size / 2));
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 24) lit += 1;
    }
    return { ok: lit > 20, lit, width, height };
  });
  if (!sample.ok) throw new Error(`Canvas pixel check failed for ${label}: ${JSON.stringify(sample)}`);
}
