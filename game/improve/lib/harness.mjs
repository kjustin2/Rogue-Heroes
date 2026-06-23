// Shared harness helpers for the self-improvement loop: boot a Vite server, find the
// cached Playwright Chromium, drive the game, and sample the WebGL canvas. Extracted so
// capture-flow and any future scripted play-throughs share one battle-tested code path.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const serverLog = [];

// Boot a Vite dev server on a dedicated strict port (a sibling project squats 5175, so the
// loop owns a port well clear of the smoke scripts). Returns { server, url } where server is
// null if something was already serving that port.
export async function startServer(port, cwd = process.cwd()) {
  const url = `http://127.0.0.1:${port}`;
  if (await isServerReady(url)) return { server: null, url };
  const viteBin = join(cwd, "node_modules", "vite", "bin", "vite.js");
  const server = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--strictPort", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
  server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));
  await waitForServer(url, 25000);
  return { server, url };
}

export async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerReady(url)) return;
    await delay(250);
  }
  throw new Error(`Server did not start at ${url}\n${serverLog.join("")}`);
}

export async function isServerReady(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

// Locate the newest cached Chromium that playwright-core can drive. Honors an explicit
// override so CI or unusual installs still work.
export function findChromium() {
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

// Wait until the sim is back in the command phase (resolve animations finished).
export async function waitForCommand(page, timeoutMs = 16000) {
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", undefined, { timeout: timeoutMs });
}

// End the current turn and wait for the resolve animation to finish.
export async function endTurnAndSettle(page, timeoutMs = 16000) {
  await page.evaluate(() => window.__rht.endTurn());
  await waitForCommand(page, timeoutMs);
}

// Sample the center of the WebGL canvas to confirm the 3D battle actually rendered (not a
// black frame). Returns { ok, lit, width, height } — the objective "is it painted" signal.
export async function sampleCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("game");
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: "missing canvas" };
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { ok: false, reason: "missing webgl context" };
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const size = 24;
    const x = Math.max(0, Math.floor(width / 2 - size / 2));
    const y = Math.max(0, Math.floor(height / 2 - size / 2));
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(x, y, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 24) lit += 1;
    }
    return { ok: lit > 30, lit, width, height };
  });
}

export { delay };
