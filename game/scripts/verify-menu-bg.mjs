// One-off visual+logic verification that the menu radar backdrop is a single persistent
// element whose animation keeps running across submenu navigation (instead of restarting).
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5188;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ms-playwright");
  for (const dir of readdirSync(base)) {
    if (dir.startsWith("chromium-")) return join(base, dir, "chrome-win", "chrome.exe");
  }
  throw new Error("No Playwright Chromium found");
}

async function ready(url) {
  try { await fetch(url); return true; } catch { return false; }
}

let server = null;
let browser = null;
try {
  if (!(await ready(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(PORT)], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    });
  }
  for (let i = 0; i < 100 && !(await ready(URL)); i++) await delay(200);

  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".main-menu");
  await delay(1200); // let the radar animation advance a bit

  // Tag the persistent backdrop and read its sweep animation clock.
  const onMain = await page.evaluate(() => {
    const bg = document.querySelector(".menu-bg");
    bg.dataset.probe = "persistent"; // survives only if the SAME node is reused later
    const anims = bg.getAnimations({ subtree: true });
    return {
      count: document.querySelectorAll(".menu-bg").length,
      menusOpen: document.body.classList.contains("menus-open"),
      sweepTime: Math.max(0, ...anims.map((a) => Number(a.currentTime) || 0)),
    };
  });
  await page.screenshot({ path: join(OUT, "menubg-1-main.png") });

  // Into Settings (a submenu) — old behavior remounted a fresh .menu-bg here.
  await page.click('[data-menu="settings"]');
  await page.waitForSelector(".menu-heading");
  await delay(900);
  const onSettings = await page.evaluate(() => {
    const bg = document.querySelector(".menu-bg");
    const anims = bg.getAnimations({ subtree: true });
    return {
      count: document.querySelectorAll(".menu-bg").length,
      sameNode: bg.dataset.probe === "persistent",
      menusOpen: document.body.classList.contains("menus-open"),
      sweepTime: Math.max(0, ...anims.map((a) => Number(a.currentTime) || 0)),
    };
  });
  await page.screenshot({ path: join(OUT, "menubg-2-settings.png") });

  const problems = [];
  if (onMain.count !== 1) problems.push(`expected 1 .menu-bg on main menu, got ${onMain.count}`);
  if (onSettings.count !== 1) problems.push(`expected 1 .menu-bg on settings, got ${onSettings.count}`);
  if (!onSettings.sameNode) problems.push("settings used a DIFFERENT .menu-bg node (radar restarted)");
  if (!onMain.menusOpen || !onSettings.menusOpen) problems.push("body.menus-open not set");
  // The sweep clock must have advanced — proof the animation kept running, not reset to 0.
  if (onSettings.sweepTime <= onMain.sweepTime) {
    problems.push(`radar clock did not advance: main=${onMain.sweepTime}ms settings=${onSettings.sweepTime}ms`);
  }

  console.log("main:", JSON.stringify(onMain));
  console.log("settings:", JSON.stringify(onSettings));
  if (problems.length) {
    console.error("FAIL:\n - " + problems.join("\n - "));
    process.exitCode = 1;
  } else {
    console.log(`PASS: one persistent backdrop, radar advanced ${onMain.sweepTime}→${onSettings.sweepTime}ms across submenu nav`);
  }
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
