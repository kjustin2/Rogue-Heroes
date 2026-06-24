// Projectile/animation showcase: stages opposing rows, makes varied unit kinds fire across
// the gap, enters the resolve phase, and burst-captures frames mid-flight so per-unit round
// variety, muzzle flashes, and firing recoil can be eyeballed. Out: shots/projectiles/
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5185;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", process.argv[2] ?? "projectiles");
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

  // Stage two opposing rows close enough that everyone is in range, then queue a shot from each
  // player unit at its opposite number and end the turn to enter resolve.
  async function setupAndFire(kinds) {
    await page.evaluate(() => window.__rht.startBattle("ironworks", "destroy", "normal"));
    await page.waitForFunction(() => window.__rht.sim.phase === "command");
    const ids = await page.evaluate(({ kinds }) => {
      const sim = window.__rht.sim;
      sim.debugGrant("player", 99999);
      sim.debugGrant("enemy", 99999);
      const n = kinds.length;
      const players = [], enemies = [];
      kinds.forEach((k, i) => {
        const z = -(n - 1) * 0.5 * 2.4 + i * 2.4;
        players.push(sim.debugSpawn(k, "player", { x: -4.5, z }).id);
        enemies.push(sim.debugSpawn(k, "enemy", { x: 4.5, z }).id);
      });
      // Each player unit fires at the enemy across from it (body shot).
      kinds.forEach((_, i) => {
        sim.debugSelect(players[i]);
        sim.queueShootPart(enemies[i], "body");
      });
      sim.deselect();
      return { players, enemies };
    }, { kinds });
    await page.evaluate(() => window.__rht.endTurn());
    return ids;
  }

  async function frame(zoom, pitch, yaw) {
    await page.evaluate(({ zoom, pitch, yaw }) => {
      window.__rht.deselect();
      window.__rht.setView({ x: 0, z: 0, zoom, pitch, yaw });
    }, { zoom, pitch, yaw });
  }

  // Burst-capture once projectiles are in the air; staggered shots mean different frames catch
  // muzzle flashes, mid-flight rounds, and recoil at different moments.
  async function burst(prefix, frames = 8, gap = 200) {
    await page.waitForFunction(() => window.__rht.sim.projectiles.length > 0, { timeout: 15000, polling: 100 });
    let maxSeen = 0;
    for (let i = 0; i < frames; i += 1) {
      const live = await page.evaluate(() => window.__rht.sim.projectiles.length);
      maxSeen = Math.max(maxSeen, live);
      await page.screenshot({ path: join(OUT, `${prefix}-${String(i).padStart(2, "0")}.png`) });
      await delay(gap);
    }
    console.log(`  ${prefix}: peak ${maxSeen} projectiles in flight`);
  }

  // Infantry mix — rifle tracers (soldier/sniper/heavy) + a grenade arc, framed tight.
  await setupAndFire(["soldier", "sniper", "heavy", "grenadier"]);
  await frame(0.34, 0.4, 0.22);
  await burst("infantry", 9);

  // Tight single duels so the per-unit round, muzzle flash, and recoil are unmistakable.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await setupAndFire(["heavy"]);
  await frame(0.24, 0.34, 0.3);
  await burst("duel-heavy", 12, 130);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await setupAndFire(["sniper"]);
  await frame(0.26, 0.32, 0.3);
  await burst("duel-sniper", 10, 150);

  // Vehicles + bolts — shells (tank/artillery) and energy bolts (apc).
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await setupAndFire(["tank", "apc", "artillery"]);
  await frame(0.42, 0.36, -0.4);
  await burst("vehicles", 9);

  const diag = await page.evaluate(() => window.__rht.diagnostics());
  console.log("  diagnostics:", JSON.stringify({ ok: diag.ok, errors: diag.errors, warnings: diag.warnings }));

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-projectiles error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
