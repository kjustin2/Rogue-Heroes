import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5179;
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
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.screenshot({ path: join(OUT, "6-menu.png") });

  // Enter the deploy screen, pick a specific map + mode through the menu, then deploy.
  await page.click('[data-menu="play"]');
  await page.waitForSelector('[data-map="ironworks"]');
  await page.click('[data-map="ironworks"]');
  await page.click('[data-mode="ctf"]');
  await page.click("[data-start]");
  await page.waitForSelector(".title-screen", { state: "detached", timeout: 4000 }).catch(() => {});
  await assertCanvasPainted(page, "flow command");

  const startState = await page.evaluate(() => ({
    map: window.__rht.sim.mapDef.id,
    mode: window.__rht.sim.mode,
    players: window.__rht.sim.fieldUnitCount("player"),
    enemies: window.__rht.sim.fieldUnitCount("enemy"),
    modeChip: Boolean(document.querySelector(".mode-chip")),
  }));
  if (startState.map !== "ironworks" || startState.mode !== "ctf") {
    throw new Error(`Menu selection not applied: ${JSON.stringify(startState)}`);
  }
  if (startState.players !== 0 || startState.enemies !== 0) {
    throw new Error(`Battle should start with no units deployed: ${JSON.stringify(startState)}`);
  }
  if (!startState.modeChip) throw new Error("Mode/score chip missing from HUD");

  // Research a doctrine, then deploy a couple of troops over the next turns.
  const built = await page.evaluate(async () => {
    const api = window.__rht;
    const sim = api.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    sim.select(base.id);
    // Grant a comfortable treasury so the harness exercises mechanics, not the price curve.
    sim.economy.set("player", 2000);
    api.researchTech("assault");
    api.endTurn();
  });
  void built;
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 2, undefined, { timeout: 16000 });

  await page.evaluate(() => {
    const api = window.__rht;
    api.sim.economy.set("player", 2000);
    api.sim.select(api.sim.entities.find((e) => e.kind === "base" && e.team === "player").id);
    api.queueSpawnTroop("striker");
    api.endTurn();
  });
  await page.waitForFunction(() => window.__rht.sim.phase === "resolve" || window.__rht.sim.turn >= 3, undefined, { timeout: 6000 });
  await assertCanvasPainted(page, "flow resolve");
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn >= 3, undefined, { timeout: 16000 });
  await page.screenshot({ path: join(OUT, "7-flow-battle.png") });

  const midState = await page.evaluate(() => ({
    players: window.__rht.sim.fieldUnitCount("player"),
    enemies: window.__rht.sim.fieldUnitCount("enemy"),
  }));
  if (midState.players < 1) throw new Error(`Player deployed no troops: ${JSON.stringify(midState)}`);

  // Reset returns to a fresh, empty battle.
  await page.evaluate(() => window.__rht.reset());
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn === 1);
  const resetState = await page.evaluate(() => ({
    turn: window.__rht.sim.turn,
    players: window.__rht.sim.fieldUnitCount("player"),
    enemies: window.__rht.sim.fieldUnitCount("enemy"),
  }));
  if (resetState.players !== 0 || resetState.enemies !== 0) {
    throw new Error(`Reset did not return to an empty start: ${JSON.stringify(resetState)}`);
  }

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  console.log(`Flow passed: menu picked ${startState.map}/${startState.mode}, deployed ${midState.players}, enemy fielded ${midState.enemies}, reset to empty.`);
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
