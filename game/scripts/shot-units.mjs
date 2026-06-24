// Unit-showcase capture: stages every unit kind in tidy rows and takes close,
// well-framed shots so model differentiation/flavor can be eyeballed and compared.
// Usage: node scripts/shot-units.mjs [outSubdir]   (default out: shots/units)
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readdirSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 5184;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", process.argv[2] ?? "units");
mkdirSync(OUT, { recursive: true });

const serverLog = [];
let server = null;
let browser = null;

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  if (!existsSync(base)) throw new Error("no ms-playwright cache");
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
  if (!dir) throw new Error("no chromium-* in ms-playwright");
  return join(base, dir, "chrome-win", "chrome.exe");
}

async function isServerReady(url) {
  try { const r = await fetch(url); return r.ok; } catch { return false; }
}
async function waitForServer(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await isServerReady(url)) return; await delay(150); }
  throw new Error("server did not start: " + serverLog.join(""));
}

try {
  if (!(await isServerReady(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
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

  // Clean, flat map; stage units in themed clusters near the origin.
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.mapDef.id === "ironworks");

  // Tight inspection camera: low pitch, slight yaw for a 3/4 view, hard zoom past the
  // interactive clamp so fine model detail is legible. Units are staged on a line at z=0
  // centred on x=0, so we focus the camera there.
  async function frame(zoom, pitch = 0.42, yaw = 0.32) {
    await page.evaluate(({ zoom, pitch, yaw }) => {
      window.__rht.deselect();
      window.__rht.setView({ x: 0, z: 0, zoom, pitch, yaw });
    }, { zoom, pitch, yaw });
    await delay(450);
  }

  async function stage(kinds, build = false, spacing = 2.9) {
    await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    await page.evaluate(({ kinds, build, spacing }) => {
      const sim = window.__rht.sim;
      sim.debugGrant("player", 8000);
      const n = kinds.length;
      kinds.forEach((k, i) => {
        const p = { x: -(n - 1) * 0.5 * spacing + i * spacing, z: 0 };
        if (build) sim.debugBuild(k, "player", p); else sim.debugSpawn(k, "player", p);
      });
      window.__rht.deselect();
    }, { kinds, build, spacing });
  }

  async function shoot(name, kinds, opts = {}) {
    await stage(kinds, opts.build, opts.spacing ?? 2.9);
    await frame(opts.zoom ?? 0.34, opts.pitch ?? 0.42, opts.yaw ?? 0.32);
    await page.screenshot({ path: join(OUT, name) });
    console.log("  shot", name);
  }

  // Pairs/triples kept small so each model is large and legible.
  await shoot("01-soldier-scout.png", ["soldier", "scout"]);
  await shoot("02-sniper-striker.png", ["sniper", "striker"]);
  await shoot("03-heavy-grenadier.png", ["heavy", "grenadier"]);
  await shoot("04-mortar-medic.png", ["mortar", "medic"]);
  await shoot("05-engineer-soldier.png", ["engineer", "soldier"]);
  // Fresh page before the heavier vehicle/defense models — many sequential startBattle()
  // resets degrade the headless (SwiftShader) renderer and can drop a frame to a stale scale.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");

  // Vehicles: one each, tight, plus a trio.
  await shoot("06-tank.png", ["tank"], { zoom: 0.42, pitch: 0.3, yaw: -0.5 });
  await shoot("06b-apc.png", ["apc"], { zoom: 0.42, pitch: 0.3, yaw: -0.5 });
  await shoot("06c-artillery.png", ["artillery"], { zoom: 0.42, pitch: 0.3, yaw: -0.5 });
  await shoot("06d-vehicles.png", ["tank", "apc", "artillery"], { zoom: 0.42, pitch: 0.36, spacing: 4.2 });
  await shoot("07-defenses.png", ["wall", "turret", "exturret"], { build: true, zoom: 0.4, pitch: 0.36, spacing: 3.6 });
  // A gameplay-distance roster so silhouette readability "at a glance" can be judged too.
  await shoot("08-roster-far.png", ["soldier", "scout", "sniper", "striker", "heavy", "grenadier"], { zoom: 0.9, pitch: 0.62, yaw: 0.2 });

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-units error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
