// One-off visual verification for the goal changes:
//  - menus no longer flash the 3D map during screen transitions
//  - units have distinct silhouettes and NO floating type labels
//  - Dust Bowl / Verdant Pass now have large mountain formations
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5182;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots/goal";
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
  await page.screenshot({ path: join(OUT, "01-main-menu.png") });

  // --- Menu flash: click Settings and grab the frame a fade would still be transparent in.
  await page.click('[data-menu="settings"]');
  await delay(60); // ~1/8 of the old 0.5s fade — old build showed the map clearly here
  await page.screenshot({ path: join(OUT, "02-settings-midtransition.png") });
  const settingsState = await page.evaluate(() => {
    const el = document.querySelector(".menu-screen");
    if (!el) return { found: false };
    return {
      found: true,
      instant: el.classList.contains("menu-screen--instant"),
      opacity: Number(getComputedStyle(el).opacity),
    };
  });
  await page.waitForSelector(".menu-heading");
  await page.screenshot({ path: join(OUT, "03-settings-settled.png") });
  await page.click("[data-back]");
  await delay(60);
  await page.screenshot({ path: join(OUT, "04-back-to-menu-midtransition.png") });

  // --- Units: stage one of every kind on Verdant Pass, no labels, distinct models.
  await page.evaluate(() => window.__rht.startBattle("verdant", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.mapDef.id === "verdant");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 4000);
    const rowA = ["soldier", "scout", "engineer", "sniper", "grenadier", "heavy"];
    const rowB = ["medic", "mortar", "striker", "tank", "apc", "artillery"];
    rowA.forEach((k, i) => sim.debugSpawn(k, "player", { x: -7 + i * 2.6, z: -8.5 }));
    rowB.forEach((k, i) => sim.debugSpawn(k, "player", { x: -7 + i * 2.6, z: -4 }));
    sim.debugSelect("p-dbg-1");
  });
  // Tab focuses the camera on the squad; zoom in a touch so the silhouettes read.
  await page.keyboard.press("Tab");
  await delay(400);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -120); await delay(60); }
  await delay(700);
  await page.screenshot({ path: join(OUT, "05-units-verdant.png") });
  const renderState = await page.evaluate(() => {
    const d = window.__rht.renderDebug();
    return { floatingLabels: d.floatingLabels, unitMarkers: d.unitMarkers, players: window.__rht.sim.fieldUnitCount("player") };
  });

  // --- Close-up infantry lineup to confirm the per-kind silhouettes read clearly.
  await page.evaluate(() => window.__rht.startBattle("verdant", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.mapDef.id === "verdant");
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 4000);
    ["soldier", "scout", "engineer", "sniper", "medic"].forEach((k, i) =>
      sim.debugSpawn(k, "player", { x: -4 + i * 2, z: 0 }));
    sim.debugSelect("p-dbg-1");
  });
  await page.keyboard.press("Tab");
  await delay(400);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -120); await delay(60); }
  await delay(700);
  await page.screenshot({ path: join(OUT, "08-infantry-closeup.png") });

  // --- Mountains: zoom out and pan north to capture the big massif on each map.
  await captureMountains(page, "verdant", "06-mountains-verdant.png");
  await captureMountains(page, "dustbowl", "07-mountains-dustbowl.png");

  // --- Round transition banner (now held ~0.5s longer) renders on the new turn.
  await page.evaluate(() => window.__rht.startBattle("verdant", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.mapDef.id === "verdant");
  await page.evaluate(() => { window.__rht.sim.debugGrant("player", 2000); window.__rht.endTurn(); });
  await page.waitForSelector(".round-transition.show", { timeout: 20000 });
  await delay(250);
  await page.screenshot({ path: join(OUT, "09-round-banner.png") });
  const bannerText = await page.evaluate(() => document.querySelector(".round-transition__label")?.textContent ?? "");
  console.log("Round banner:", JSON.stringify(bannerText));

  console.log("Render state:", JSON.stringify(renderState));
  console.log("Settings transition:", JSON.stringify(settingsState));
  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  if (!settingsState.instant || settingsState.opacity < 0.98) {
    throw new Error(`Menu still fades on transition: ${JSON.stringify(settingsState)}`);
  }
  if (renderState.floatingLabels !== 0) throw new Error(`Expected no floating labels, got ${renderState.floatingLabels}`);
  console.log("Goal screenshots captured to", OUT);
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}

async function captureMountains(page, mapId, file) {
  await page.evaluate((id) => window.__rht.startBattle(id, "destroy", "normal"), mapId);
  await page.waitForFunction((id) => window.__rht.sim.mapDef.id === id, mapId);
  // Drop a couple of scouts near the north massif and Tab to frame that corner.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 2000);
    sim.debugSpawn("scout", "player", { x: 0, z: 8 });
    sim.debugSpawn("tank", "player", { x: 4, z: 6 });
    sim.debugSelect("p-dbg-1");
  });
  await page.keyboard.press("Tab");
  await delay(300);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 120); await delay(60); } // zoom out
  await delay(800);
  await page.screenshot({ path: join(OUT, file) });
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await delay(250);
  }
  throw new Error(`Server did not start at ${url}\n${serverLog.join("")}`);
}
async function isServerReady(url) { try { return (await fetch(url)).ok; } catch { return false; } }
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const root = join(local, "ms-playwright");
  if (!existsSync(root)) throw new Error(`Missing Playwright browser cache: ${root}`);
  const matches = readdirSync(root)
    .filter((n) => n.startsWith("chromium-"))
    .map((n) => join(root, n, "chrome-win64", "chrome.exe"))
    .filter((p) => existsSync(p))
    .sort();
  if (!matches.length) throw new Error(`No cached Chromium under ${root}`);
  return matches[matches.length - 1];
}
