// Exercises every interactive button across the menus and the in-battle HUD, asserting that
// each one does something sensible and that no console/page errors fire along the way.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = Number(process.env.SMOKE_PORT ?? 5191);
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";
mkdirSync(OUT, { recursive: true });
const serverLog = [];
let server = null;
let browser = null;

const fail = (msg) => { throw new Error(msg); };

try {
  if (!(await ready(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (c) => serverLog.push(c.toString()));
    server.stderr.on("data", (c) => serverLog.push(c.toString()));
  }
  await waitForServer(URL, 20000);
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.addInitScript(() => { try { localStorage.clear(); localStorage.setItem("rht.progression.v1", JSON.stringify({ points: 500, unlocked: ["default"], accent: "default" })); } catch {} });
  await page.goto(URL, { waitUntil: "networkidle" });

  // 1) The game must boot to the main menu.
  await page.waitForSelector(".main-menu");
  for (const sel of ['[data-menu="play"]', '[data-menu="tutorial"]', '[data-menu="armory"]', '[data-menu="settings"]']) {
    if (!(await page.$(sel))) fail(`Main menu missing button ${sel}`);
  }

  // 2) Settings — every control.
  await page.click('[data-menu="settings"]');
  await page.waitForSelector('[data-set="mute"]');
  await page.click('[data-set="mute"]');
  if (await muted(page) !== true) fail("Mute toggle did not mute");
  await page.click('[data-set="mute"]');
  if (await muted(page) !== false) fail("Mute toggle did not unmute");
  await page.click('[data-set="motion"]');
  await page.$$eval('[data-set="diff"]', (els) => els.forEach((e) => e.click()));
  await page.evaluate(() => { const r = document.querySelector('input[data-set="volume"]'); if (r) { r.value = "40"; r.dispatchEvent(new Event("input", { bubbles: true })); } });
  await page.click('[data-back]');
  await page.waitForSelector(".main-menu");

  // 3) Armory — unlock + equip a cosmetic.
  await page.click('[data-menu="armory"]');
  await page.waitForSelector(".armory-grid");
  const unlockBtn = await page.$('[data-unlock]');
  if (unlockBtn) {
    await unlockBtn.click();
    await page.waitForSelector(".armory-grid");
  }
  const equipBtn = await page.$('[data-equip]:not(.on)');
  if (equipBtn) { await equipBtn.click(); await page.waitForSelector(".armory-grid"); }
  await page.click('[data-back]');
  await page.waitForSelector(".main-menu");

  // 4) Deploy screen — every map preview renders, mode + difficulty selectable.
  await page.click('[data-menu="play"]');
  await page.waitForSelector(".map-preview-svg");
  const mapIds = await page.$$eval("[data-map]", (els) => els.map((e) => e.dataset.map));
  for (const id of mapIds) {
    await page.click(`[data-map="${id}"]`);
    await page.waitForSelector(".map-preview-svg");
  }
  await page.click('[data-mode="hill"]');
  await page.click('[data-diff="normal"]');
  await page.click('[data-map="dustbowl"]');
  await page.click("[data-start]");
  await page.waitForSelector(".title-screen", { state: "detached", timeout: 4000 }).catch(() => {});
  if (await page.$(".main-menu")) fail("Start Game did not dismiss the menu");

  // 5) Base command deck — deploy, research, income, command, build.
  const baseId = await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.economy.set("player", 4000);
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    base.commandPoints = 6;
    base.maxCommandPoints = 1;
    sim.select(base.id);
    return base.id;
  });
  await page.click(`[data-select="${baseId}"]`);
  await page.waitForSelector('[data-spawn="soldier"]');
  await page.click('[data-spawn="soldier"]');
  if (!(await page.evaluate(() => window.__rht.sim.entities.some((e) => e.id.startsWith("p-spawn-"))))) fail("Deploy button did not spawn");
  await refreshBaseCp(page, baseId);
  await page.click('[data-tech="recon"]');
  if (!(await page.evaluate(() => (window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").unlockedTech ?? []).includes("recon")))) fail("Tech button did not research");
  await refreshBaseCp(page, baseId);
  await page.click('[data-base-upgrade="income"]');
  if (await page.evaluate(() => (window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").incomeLevel ?? 0)) < 1) fail("Income upgrade button failed");
  await refreshBaseCp(page, baseId);
  await page.click('[data-base-upgrade="command"]');
  if (await page.evaluate(() => window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "player").maxCommandPoints) !== 2) fail("Command upgrade button failed");
  await refreshBaseCp(page, baseId);
  await page.click('[data-build="turret"]');
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const base = sim.entities.find((e) => e.kind === "base" && e.team === "player");
    window.__rht.queueBuildStructure({ x: base.position.x + 4, z: base.position.z + 3 });
  });
  if (!(await page.evaluate(() => window.__rht.sim.entities.some((e) => e.kind === "turret")))) fail("Build button + placement failed");

  // 6) Unit action chain — select, Move arms, Shoot -> part -> Confirm queues an order.
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const sol = sim.entities.find((e) => e.id.startsWith("p-spawn-") && e.kind === "soldier");
    const ebase = sim.entities.find((e) => e.kind === "base" && e.team === "enemy");
    // clear any cover near the line, set the soldier just in front of the enemy base
    sim.entities.filter((e) => e.kind === "cover").forEach((c) => { c.position.x = 0; c.position.z = 14; });
    sol.position = { x: ebase.position.x - 4, z: ebase.position.z };
    sol.commandPoints = 4;
    sol.stance = "standing";
    sim.select(sol.id);
  });
  const solId = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.id.startsWith("p-spawn-") && e.kind === "soldier").id);
  await page.click(`[data-select="${solId}"]`);
  await page.click('[data-order-action="move"]');
  if (await page.evaluate(() => window.__rht.sim.intent) !== "move") fail("Move button did not arm move mode");
  // Re-select to return to the action deck, then arm Shoot (the deck collapses once focused).
  await page.click(`[data-select="${solId}"]`);
  await page.waitForSelector('[data-order-action="shoot"]');
  await page.click('[data-order-action="shoot"]');
  await page.waitForSelector(".target-panel");
  const ebaseId = await page.evaluate(() => window.__rht.sim.entities.find((e) => e.kind === "base" && e.team === "enemy").id);
  await page.click(`[data-select="${ebaseId}"]`);
  await page.waitForSelector(".part-choice");
  await page.click(".part-choice");
  const confirm = await page.$('[data-confirm="shoot"][data-disabled="false"]');
  if (!confirm) fail("Shoot confirm button was not enabled against a close base");
  await confirm.click();
  if (await page.evaluate(() => window.__rht.sim.orders.length) < 1) fail("Confirm Shoot did not queue an order");

  // Crouch the soldier via its action button.
  await page.evaluate(() => { const sim = window.__rht.sim; const sol = sim.entities.find((e) => e.id.startsWith("p-spawn-") && e.kind === "soldier"); sol.commandPoints = 2; sim.select(sol.id); });
  await page.click(`[data-select="${solId}"]`);
  await page.click('[data-order-action="defend"]');
  await page.click('[data-confirm="defend"]');
  if (await page.evaluate(() => window.__rht.sim.orders.some((o) => o.kind === "defend")) !== true) fail("Crouch/defend button did not queue");

  // 7) Log toggle open + close.
  await page.click(".log-toggle");
  await page.waitForSelector(".compact-log.expanded");
  await page.click(".log-toggle");
  await page.waitForFunction(() => !document.querySelector(".compact-log.expanded"));

  // 8) Unit Edit overlay.
  await page.click(`[data-detail="${solId}"]`);
  await page.waitForSelector(".unit-detail-panel");
  await page.click(`[data-edit-unit="${solId}"]`);
  await page.waitForSelector(".edit-overlay");
  await page.fill(".edit-name", "Sentinel");
  const accentBtn = await page.$(".edit-accent");
  if (accentBtn) await accentBtn.click();
  await page.click("[data-apply]");
  if (await page.evaluate((id) => window.__rht.sim.entity(id)?.name, solId) !== "Sentinel") fail("Edit overlay apply failed");

  // 9) Pause menu: Save, Controls (+ back), Resume.
  await page.click('[data-command="open-menu"]');
  await page.waitForSelector(".pause-overlay .pause-buttons");
  await page.click('[data-pause="save"]');
  await page.waitForFunction(() => document.querySelector("[data-feedback]")?.textContent?.includes("saved"));
  await page.click('[data-pause="controls"]');
  await page.waitForSelector(".controls-grid");
  await page.click('[data-back]');
  await page.waitForSelector(".pause-buttons");
  await page.click('[data-pause="resume"]');
  await page.waitForFunction(() => !document.querySelector(".pause-overlay"));

  // 10) End Turn button resolves.
  const turnBefore = await page.evaluate(() => window.__rht.sim.turn);
  await page.click('[data-command="end"]');
  await page.waitForFunction((t) => window.__rht.sim.phase === "command" && window.__rht.sim.turn > t, turnBefore, { timeout: 16000 });

  // 11) End screen buttons -> Play Again and Main Menu. (Flag a victory to surface the screen.)
  await page.evaluate(() => { window.__rht.sim.phase = "victory"; });
  await page.waitForSelector(".endscreen");
  if (!(await page.$('[data-command="reset"]')) || !(await page.$('[data-command="to-menu"]'))) fail("End screen missing Play Again / Main Menu buttons");
  await page.click('[data-command="to-menu"]');
  await page.waitForSelector(".main-menu");
  if (!(await page.$('[data-menu="continue"]'))) fail("Continue button missing after a save");

  if (errors.length) fail(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  console.log("Buttons smoke passed: menus, base deck, unit actions, log, edit, pause/save, end turn, end screen.");
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}

async function muted(page) {
  return page.evaluate(() => document.querySelector('[data-set="mute"]')?.textContent?.trim() === "Muted");
}
async function refreshBaseCp(page, baseId) {
  await page.evaluate((id) => { const b = window.__rht.sim.entity(id); b.commandPoints = 6; window.__rht.sim.select(id); }, baseId);
  await page.click(`[data-select="${baseId}"]`);
}
async function waitForServer(url, t) { const s = Date.now(); while (Date.now() - s < t) { try { if ((await fetch(url)).ok) return; } catch {} await delay(250); } throw new Error("server\n" + serverLog.join("")); }
async function ready(url) { try { return (await fetch(url)).ok; } catch { return false; } }
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const root = join(local, "ms-playwright");
  const m = readdirSync(root).filter((n) => n.startsWith("chromium-")).map((n) => join(root, n, "chrome-win64", "chrome.exe")).filter((p) => existsSync(p)).sort();
  if (!m.length) throw new Error("No cached Chromium");
  return m[m.length - 1];
}
