// Screenshot capture for the "Also…" feedback round: overwatch direction cone, capturable/
// volatile object clarity, base-menu subcategory tabs, the tech tree, infantry melee, and the
// burn-mark-at-distance fix. Drives the real renderer via window.__rht (full FX).
// Usage: node scripts/shot-feedback-round.mjs   (out: shots/feedback)
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5185;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "feedback");
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

  async function startMap(mapId) {
    await page.evaluate((m) => window.__rht.startBattle(m, "destroy", "normal"), mapId);
    await page.waitForFunction((m) => window.__rht.sim.mapDef.id === m && window.__rht.sim.phase === "command", mapId);
    await delay(350);
  }
  async function setView(v) { await page.evaluate((view) => window.__rht.setView(view), v); await delay(400); }
  async function shot(name) { await page.screenshot({ path: join(OUT, name) }); console.log("  shot", name); }

  // ---- 1 & 2: Home Base subcategory tabs + tech tree ----
  await startMap("dustbowl");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 9000);
    const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
    base.unlockedTech = ["recon", "assault", "armor"]; // mix of done / available / locked states
    base.commandPoints = 2;
    window.__rht.chooseBoardEntity(base.id);
  });
  await delay(400);
  await shot("01-base-deploy-tab.png");
  await page.click('[data-base-tab="tech"]');
  await delay(400);
  await shot("02-base-tech-tree.png");

  // ---- 6: infantry melee — the Strike action is now in a Recruit's command deck ----
  await startMap("dustbowl");
  const soldierId = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 4000);
    const s = sim.debugSpawn("soldier", "player", { x: 0, z: 0 });
    sim.debugSpawn("soldier", "enemy", { x: 2.2, z: 0 });
    window.__rht.chooseBoardEntity(s.id);
    return s.id;
  });
  await setView({ x: 0, z: 0, zoom: 0.5, pitch: 0.5, yaw: 0.3 });
  await shot("06-melee-command-deck.png");

  // ---- 3: overwatch direction cone + radius ----
  // Watcher at origin, aim due east (+X); the lone enemy sits exactly in the aim direction so
  // the wedge must cover it if the orientation is right. Near-top-down camera to read direction.
  await startMap("dustbowl");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 4000);
    const s = sim.debugSpawn("soldier", "player", { x: 0, z: 0 });
    sim.debugSpawn("soldier", "enemy", { x: 6, z: 0 });   // due east — inside the aimed cone
    sim.debugSpawn("soldier", "enemy", { x: 0, z: 6 });   // due north — OUTSIDE the aimed cone
    window.__rht.chooseBoardEntity(s.id);
    window.__rht.queueOverwatchToward({ x: 9, z: 0 });    // watch east; renders the amber wedge
    window.__rht.setIntent("select");
  });
  await setView({ x: 2, z: 1, zoom: 0.7, pitch: 1.15, yaw: 0.0 });
  await shot("03-overwatch-cone.png");

  // ---- 4: capturable supply depot clarity (blurb + Capture button) ----
  await startMap("dustbowl");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 4000);
    const depot = sim.entities.find((e) => e.coverKind === "depot");
    if (!depot) return;
    const s = sim.debugSpawn("soldier", "player", { x: depot.position.x + 2, z: depot.position.z });
    window.__rht.chooseBoardEntity(s.id);       // select the unit first (so Capture has an actor)
    window.__rht.chooseBoardEntity(depot.id);   // open the depot interaction panel
  });
  await delay(400);
  await shot("04-capture-depot-panel.png");

  // ---- 5: volatile prop clarity (fuel/ammo blurb) ----
  await startMap("dustbowl");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const vol = sim.entities.find((e) => e.coverKind === "fuel" || e.coverKind === "ammo");
    if (!vol) return;
    const s = sim.debugSpawn("soldier", "player", { x: vol.position.x + 2, z: vol.position.z });
    window.__rht.chooseBoardEntity(s.id);
    window.__rht.chooseBoardEntity(vol.id);
  });
  await delay(400);
  await shot("05-volatile-prop-panel.png");

  // ---- 7 & 8: burn-mark decal persists near AND far (the reported bug fix) ----
  // Two grenades at the same spot leave a clear scorch; then we shoot it up close and pulled
  // far back. Before the polygonOffset fix, the ground occluded the decal when zoomed out.
  await startMap("dustbowl");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 4000);
    const a = sim.debugSpawn("soldier", "player", { x: -3, z: -1 });
    const b = sim.debugSpawn("soldier", "player", { x: -3, z: 1 });
    sim.debugSpawn("soldier", "enemy", { x: 8, z: 0 });
    window.__rht.chooseBoardEntity(a.id);
    window.__rht.setIntent("grenade");
    window.__rht.queueGrenadeAt({ x: 2, z: -0.4 });
    window.__rht.chooseBoardEntity(b.id);
    window.__rht.setIntent("grenade");
    window.__rht.queueGrenadeAt({ x: 2.4, z: 0.6 });
    window.__rht.setIntent("select");
  });
  await page.evaluate(() => window.__rht.endTurn());
  // Poll until resolve completes and we're in command (blasts + scorches created).
  await page.waitForFunction(() => window.__rht.sim.phase === "command" && window.__rht.sim.turn >= 2, null, { timeout: 15000 });
  await delay(2600); // let the "TURN 2" transition banner clear
  await page.evaluate(() => window.__rht.deselect());
  await setView({ x: 2.2, z: 0, zoom: 0.42, pitch: 0.5, yaw: 0.15 }); // close
  await shot("07-burn-near.png");
  await setView({ x: 2.2, z: 0, zoom: 2.0, pitch: 0.78, yaw: 0.15 }); // pulled far back
  await shot("08-burn-far.png");

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 10).join("\n")); process.exitCode = 1; }
  else console.log("OK ->", OUT);
} catch (err) {
  console.error("shot-feedback-round error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
