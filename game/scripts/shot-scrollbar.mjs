// Verify (1) the themed scrollbar renders on a scrollable menu, and (2) wheeling over a scrollable
// menu scrolls the MENU and never zooms the world. Out: shots/scrollbar/*.png
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5187;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = join("shots", "scrollbar");
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
  await page.evaluate(() => window.__rht.startBattle("dustbowl", "destroy", "normal"));
  await page.waitForFunction(() => window.__rht.sim.phase === "command");

  // Open the tech tree (a tall, scrollable tab body).
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    sim.debugGrant("player", 9000);
    const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
    base.unlockedTech = ["recon", "assault", "armor"];
    base.commandPoints = 2;
    window.__rht.chooseBoardEntity(base.id);
  });
  await delay(300);
  await page.click('[data-base-tab="tech"]');
  await delay(300);
  await page.screenshot({ path: join(OUT, "01-scrollbar.png") });
  console.log("  shot 01-scrollbar.png");

  // Behavior: hover the tech tab and wheel — the tab should scroll, the camera zoom must not change.
  const box = await page.evaluate(() => {
    const el = document.querySelector(".base-tab-body");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, scrollTop: el.scrollTop, scrollable: el.scrollHeight > el.clientHeight + 1 };
  });
  if (!box) throw new Error("no .base-tab-body found");
  if (!box.scrollable) throw new Error(".base-tab-body is not scrollable at this viewport (test needs a taller tree/shorter panel)");
  const zoomBefore = await page.evaluate(() => window.__rht.camera().zoom);
  await page.mouse.move(box.cx, box.cy);
  await page.mouse.wheel(0, 400);
  await delay(250);
  const after = await page.evaluate(() => {
    const el = document.querySelector(".base-tab-body");
    return { scrollTop: el.scrollTop, zoom: window.__rht.camera().zoom };
  });
  await page.screenshot({ path: join(OUT, "02-after-scroll.png") });
  console.log("  shot 02-after-scroll.png");

  // Hover directly over the scrollbar rail so an auto-hiding overlay scrollbar reveals itself, and
  // zoom in a tight crop on the rail so the brass thumb styling is legible.
  const rail = await page.evaluate(() => {
    const el = document.querySelector(".base-tab-body");
    const r = el.getBoundingClientRect();
    return { x: r.right - 7, y: r.top + r.height / 2, top: r.top, right: r.right, bottom: r.bottom };
  });
  await page.mouse.move(rail.x, rail.y);
  await page.mouse.wheel(0, 40); // nudge to trigger the overlay reveal
  await delay(120);
  await page.screenshot({
    path: join(OUT, "03-scrollbar-crop.png"),
    clip: { x: Math.max(0, rail.right - 90), y: rail.top - 6, width: 100, height: Math.min(500, rail.bottom - rail.top + 12) },
  });
  console.log("  shot 03-scrollbar-crop.png");

  const scrolled = after.scrollTop > box.scrollTop + 5;
  const zoomHeld = Math.abs(after.zoom - zoomBefore) < 1e-6;
  console.log(`  menu scrollTop ${box.scrollTop} -> ${after.scrollTop} (scrolled=${scrolled}); camera zoom ${zoomBefore} -> ${after.zoom} (held=${zoomHeld})`);
  if (!scrolled) { console.error("FAIL: wheel over the tech tab did NOT scroll it"); process.exitCode = 1; }
  if (!zoomHeld) { console.error("FAIL: wheel over the tech tab ZOOMED the world"); process.exitCode = 1; }
  if (scrolled && zoomHeld) console.log("OK: menu scrolled, world did not zoom");

  if (errors.length) { console.error("CONSOLE ERRORS:\n" + errors.slice(0, 8).join("\n")); process.exitCode = 1; }
} catch (err) {
  console.error("shot-scrollbar error:", err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
