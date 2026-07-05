// Verify the air layer: a gunship flying at altitude (with a ground shadow below it + spinning
// rotor), a Flak Track on the ground, and the gunship's bomb-drop aim radius. Out: shots/air/*.png
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5189;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "air");
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
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  const gunId = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 6000);
    const gun = sim.debugSpawn("gunship", "player", { x: -2, z: 0 });
    sim.debugSpawn("flak", "player", { x: -4, z: 3 });
    sim.debugSpawn("gunship", "enemy", { x: 5, z: -1 });
    sim.debugSpawn("soldier", "enemy", { x: 3, z: 2 });
    window.__rht.deselect();
    return gun.id;
  });
  const g = await page.evaluate((id) => {
    const e = window.__rht.sim.entity(id);
    return { flying: e.flying, elevation: e.elevation, agl: e.agl };
  }, gunId);
  console.log("  gunship:", JSON.stringify(g));

  // A low, pulled-back angle: the flyer sits at ~7 units up, and the camera looks at ground level,
  // so a lower pitch + a focus behind it drops the airframe into frame alongside its ground shadow.
  await page.evaluate(() => window.__rht.setView({ x: -2, z: 6, zoom: 0.62, pitch: 0.28, yaw: 0.12 }));
  await delay(700); // let the rotor + hover animate a beat
  await page.screenshot({ path: join(OUT, "01-air-units.png") });
  console.log("  shot 01-air-units.png");

  // The gunship's bomb-drop aim: select it, arm Bomb (grenade intent), hover a ground spot to
  // preview the blast radius.
  await page.evaluate((id) => { window.__rht.chooseBoardEntity(id); window.__rht.setIntent("grenade"); }, gunId);
  await delay(200);
  // Move the cursor over open ground near the center of the canvas to trigger the ground-aim disc.
  await page.mouse.move(820, 470);
  await delay(300);
  await page.screenshot({ path: join(OUT, "02-bomb-aim.png") });
  console.log("  shot 02-bomb-aim.png");

  if (!g.flying || !(g.elevation > 4)) { console.error("FAIL: gunship not flying at altitude", JSON.stringify(g)); process.exitCode = 1; }
  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-air error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
