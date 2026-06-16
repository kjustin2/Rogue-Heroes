import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const PORT = 5175;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = "shots";

mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(OUT)) {
  if (file.endsWith(".png")) unlinkSync(join(OUT, file));
}

const serverLog = [];
let server = null;

try {
  if (!(await isServerReady(URL))) {
    const viteBin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
    server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
    server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  }

  await waitForServer(URL, 20000);
  const executablePath = findChromium();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  const errors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".topbar");
  await assertCanvasPainted(page, "desktop command");
  await assertHudLayout(page, "desktop command", [".topbar", ".roster", ".target-panel", ".commandbar", ".log"]);
  await page.screenshot({ path: join(OUT, "1-command.png") });

  await page.locator('[data-select="e-soldier-1"]').click();
  await page.locator('.part-choice[data-part="head"]').click();
  await page.waitForFunction(() => document.querySelector(".target-summary")?.textContent?.includes("Line blocked"));
  const blockedState = await page.evaluate(() => {
    const preview = window.__rht.sim.previewShot(window.__rht.sim.selectedId, "e-soldier-1", "head");
    return {
      preview,
      targetTitle: document.querySelector(".target-panel h2")?.textContent,
      summary: document.querySelector(".target-summary")?.textContent,
      activeParts: Array.from(document.querySelectorAll(".part-choice.active")).map((el) => el.getAttribute("data-part")),
    };
  });
  if (!blockedState.targetTitle?.includes("Cutlass")) throw new Error(`Expected Cutlass target details, got ${blockedState.targetTitle}`);
  if (!blockedState.preview?.blockedById) throw new Error(`Expected blocked preview for Cutlass head shot, got ${JSON.stringify(blockedState)}`);
  if (!blockedState.summary?.includes("Line blocked")) throw new Error(`Blocked target summary was unclear: ${blockedState.summary}`);
  if (blockedState.activeParts.length !== 1 || blockedState.activeParts[0] !== "head") {
    throw new Error(`Expected exactly one selected head part, got ${JSON.stringify(blockedState.activeParts)}`);
  }
  const shootTip = await page.locator('[data-order-action="shoot"]').getAttribute("data-tip");
  if (!shootTip?.includes("battlefield line")) throw new Error(`Shoot tooltip does not explain projectile line: ${shootTip}`);
  await page.locator('[data-confirm="shoot"]').hover();
  await page.screenshot({ path: join(OUT, "2-blocked-targeting.png") });

  await page.locator('[data-select="e-tank-1"]').click();
  await page.waitForSelector(".target-panel");
  const targetTitle = await page.locator(".target-panel h2").first().textContent();
  if (!targetTitle?.includes("Breaker")) throw new Error(`Expected Breaker target details, got ${targetTitle}`);
  if (await page.locator('.part-choice[data-part="head"]').count()) {
    throw new Error("Tank target exposed an invalid head part option");
  }
  await page.locator('.part-choice[data-part="left-tread"]').click();
  await page.waitForFunction(() => document.querySelector(".target-summary")?.textContent?.includes("Current line is clear"));
  const treadTip = await page.locator('.part-choice[data-part="left-tread"]').getAttribute("data-tip");
  if (!treadTip?.includes("Estimated damage")) throw new Error(`Missing damage tooltip on tread option: ${treadTip}`);
  const preview = await page.evaluate(() => window.__rht.sim.previewShot("p-tank-1", "e-tank-1", "left-tread"));
  if (!preview || preview.blockedById) throw new Error(`Expected clear preview for tank tread shot, got ${JSON.stringify(preview)}`);
  const targetPanelText = await page.locator(".target-panel").textContent();
  if (!targetPanelText?.includes("Left Tread") || !targetPanelText.includes("34/34")) {
    throw new Error(`Target panel did not highlight selected tread detail: ${targetPanelText}`);
  }
  await assertHudLayout(page, "desktop targeting", [".topbar", ".roster", ".target-panel", ".commandbar", ".log"]);
  await page.screenshot({ path: join(OUT, "3-clear-targeting.png") });
  await page.locator('[data-confirm="shoot"]').click();

  await page.evaluate(() => {
    const openTarget = window.__rht.sim.entity("e-soldier-1");
    openTarget.position.x = -2.8;
    openTarget.position.z = -6.4;
  });
  await page.locator('[data-select="p-soldier-2"]').click();
  await page.locator('[data-select="e-soldier-1"]').click();
  await page.locator('.part-choice[data-part="rifle"]').click();
  await page.locator('[data-confirm="shoot"]').click();
  await page.locator('[data-command="end"]').click();
  await page.mouse.move(820, 420);

  await page.waitForTimeout(550);
  const projectileCount = await page.evaluate(() => window.__rht.sim.projectiles.length);
  if (projectileCount < 1) throw new Error("Expected visible projectile travel during resolve");
  await page.screenshot({ path: join(OUT, "4-projectiles.png") });

  await page.waitForFunction(() => window.__rht.sim.phase === "command", undefined, { timeout: 5000 });
  await assertCanvasPainted(page, "desktop resolved");
  await assertHudLayout(page, "desktop resolved", [".topbar", ".roster", ".target-panel", ".commandbar", ".log"]);
  await page.screenshot({ path: join(OUT, "5-resolved.png") });

  const state = await page.evaluate(() => {
    const enemyTank = window.__rht.sim.entity("e-tank-1");
    const enemySoldier = window.__rht.sim.entity("e-soldier-1");
    const cover = window.__rht.sim.entities
      .filter((entity) => entity.kind === "cover")
      .map((entity) => ({ id: entity.id, hp: entity.parts[0]?.hp }));
    return {
      phase: window.__rht.sim.phase,
      tankTreadHp: enemyTank?.parts.find((p) => p.id === "left-tread")?.hp,
      soldierRifleHp: enemySoldier?.parts.find((p) => p.id === "rifle")?.hp,
      cover,
      log: window.__rht.sim.log.slice(),
    };
  });

  if (errors.length) throw new Error(`Console errors:\n${errors.slice(0, 12).join("\n")}`);
  if (state.phase !== "command") throw new Error(`Expected command phase after resolve, got ${state.phase}`);
  if (!(typeof state.tankTreadHp === "number" && state.tankTreadHp < 34)) {
    throw new Error(`Expected tank tread damage, got ${state.tankTreadHp}`);
  }
  if (!(typeof state.soldierRifleHp === "number" && state.soldierRifleHp < 18)) {
    throw new Error(`Expected soldier rifle damage, got ${state.soldierRifleHp}\n${JSON.stringify(state, null, 2)}`);
  }

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(500);
  await assertCanvasPainted(page, "mobile");
  await assertHudLayout(page, "mobile", [".topbar", ".roster", ".target-panel", ".commandbar"]);
  await page.screenshot({ path: join(OUT, "6-mobile.png") });

  await browser.close();
  console.log("Smoke passed");
} finally {
  if (server) server.kill();
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server still starting
    }
    await delay(250);
  }
  throw new Error(`Server did not start at ${url}\n${serverLog.join("")}`);
}

async function isServerReady(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const root = join(local, "ms-playwright");
  if (!existsSync(root)) throw new Error(`Missing Playwright browser cache: ${root}`);

  const matches = readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => join(root, name, "chrome-win64", "chrome.exe"))
    .filter((path) => existsSync(path))
    .sort();

  if (!matches.length) throw new Error(`No cached Chromium executable under ${root}`);
  return matches[matches.length - 1];
}

async function assertCanvasPainted(page, label) {
  const sample = await page.evaluate(() => {
    const canvas = document.getElementById("game");
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: "missing canvas" };
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { ok: false, reason: "missing webgl context" };
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const size = 18;
    const x = Math.max(0, Math.floor(width / 2 - size / 2));
    const y = Math.max(0, Math.floor(height / 2 - size / 2));
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 24) lit += 1;
    }
    return { ok: lit > 20, lit, width, height };
  });
  if (!sample.ok) throw new Error(`Canvas pixel check failed for ${label}: ${JSON.stringify(sample)}`);
}

async function assertHudLayout(page, label, selectors) {
  const result = await page.evaluate((items) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const boxes = items.map((selector) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) return { selector, missing: true };
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return {
        selector,
        missing: false,
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 8 && rect.height > 8,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        viewport: { vw, vh },
      };
    });
    const issues = boxes.filter((box) => {
      if (box.missing || !box.visible) return true;
      return box.left < -2 || box.top < -2 || box.right > vw + 2 || box.bottom > vh + 2;
    });
    return { boxes, issues };
  }, selectors);
  if (result.issues.length) throw new Error(`HUD layout check failed for ${label}: ${JSON.stringify(result, null, 2)}`);
}
