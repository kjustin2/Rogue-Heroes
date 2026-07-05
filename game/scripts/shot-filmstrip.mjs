// Combat-animation filmstrip: sets up a shooter + target, ends the turn, and grabs a rapid
// burst of frames through the resolve so motion (walk, recoil, HIT FLINCH, death) can be judged
// as a sequence rather than a still. Out: shots/filmstrip/NN.png
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5186;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "filmstrip");
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
async function isServerReady(url) { try { const r = await fetch(url); return r.ok; } catch { return false; } }
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
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.mapDef.id === "ironworks" && window.__rht.sim.phase === "command");

  // Two facing squads trade fire so tracers, muzzle flashes, impacts, blasts and hit-flinches all
  // render during resolve — verifies the pooled projectile/effect materials survived the disposal
  // change and the flinch fires. Grab a dense burst through the volley.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 8000);
    for (let i = 0; i < 3; i += 1) {
      const p = sim.debugSpawn(["heavy", "soldier", "sniper"][i], "player", { x: -4, z: (i - 1) * 2.4 });
      const e = sim.debugSpawn(["soldier", "heavy", "soldier"][i], "enemy", { x: 4, z: (i - 1) * 2.4 });
      p.commandPoints = 2;
      sim.select(p.id);
      sim.queueShootPart(e.id, "body");
    }
    window.__rht.deselect();
  });
  await page.evaluate(() => window.__rht.setView({ x: 0, z: 0, zoom: 0.5, pitch: 0.5, yaw: 0.2 }));
  await delay(300);
  await page.evaluate(() => window.__rht.endTurn());
  for (let i = 0; i < 12; i += 1) {
    await page.screenshot({ path: join(OUT, "combat-" + String(i).padStart(2, "0") + ".png") });
    await delay(120);
  }
  console.log("combat filmstrip 12 frames ->", OUT);
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
} catch (err) {
  console.error("shot-filmstrip error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
