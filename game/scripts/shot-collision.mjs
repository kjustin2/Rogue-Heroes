// Collision audit: a ground unit ordered to move THROUGH a wall/cover must stop at it, never pass
// through — re-verifies blockedMoveDestination after the walk-through fix. Out: shots/collision/*.png
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5204;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "collision");
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
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  const info = await page.evaluate(() => {
    const sim = window.__rht.sim;
    // A soldier just in front of a solid wall block; order it to move straight THROUGH the wall.
    const wall = sim.debugBuild ? null : null;
    const s = sim.debugSpawn("soldier", "player", { x: -6, z: 0 });
    // Find the nearest solid cover on the map roughly ahead of the soldier.
    const covers = sim.entities.filter((e) => e.kind === "cover" && e.coverKind !== "ridge" && e.status.alive);
    covers.sort((a, b) => Math.hypot(a.position.x - s.position.x, a.position.z - s.position.z) - Math.hypot(b.position.x - s.position.x, b.position.z - s.position.z));
    const wallE = covers[0];
    // Move the soldier right up against a wall and order it straight past the wall.
    s.position = { x: wallE.position.x - 3, z: wallE.position.z };
    const beyond = { x: wallE.position.x + 4, z: wallE.position.z }; // a spot on the FAR side of the wall
    sim.select(s.id);
    sim.queueMove(beyond);
    sim.endTurn();
    return { soldier: s.id, wallX: +wallE.position.x.toFixed(2), wallR: +wallE.radius.toFixed(2), startX: +(wallE.position.x - 3).toFixed(2) };
  });
  // Resolve, then read where the soldier ended up.
  await page.waitForFunction(() => window.__rht.sim.phase === "command" || window.__rht.sim.gameOver, null, { timeout: 8000 }).catch(() => {});
  const res = await page.evaluate((id) => { const s = window.__rht.sim.entity(id); return { x: +s.position.x.toFixed(2), z: +s.position.z.toFixed(2) }; }, info.soldier);
  await page.evaluate((info) => window.__rht.setView({ x: info.wallX - 1, z: 0, zoom: 0.62, pitch: 0.4, yaw: 0.1 }), info);
  await delay(500);
  await page.screenshot({ path: join(OUT, "01-stopped-at-wall.png") });
  const passedThrough = res.x > info.wallX; // ended on the far side of the wall = walked through
  console.log(`  wall at x=${info.wallX} (r=${info.wallR}); soldier started x=${info.startX}, ended x=${res.x} — passedThrough=${passedThrough}`);

  let ok = true;
  if (passedThrough) { console.error("FAIL: the soldier walked THROUGH the wall", { res, info }); ok = false; }
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); ok = false; }
  if (!ok) process.exitCode = 1; else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-collision error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
