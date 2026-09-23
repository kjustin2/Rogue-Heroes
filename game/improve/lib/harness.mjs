// Shared harness helpers for the self-improvement loop: boot a Vite server, find the
// cached Playwright Chromium, drive the game, and sample the WebGL canvas. Extracted so
// capture-flow and any future scripted play-throughs share one battle-tested code path.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

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

// Kill a spawned Vite server AND its children. On Windows, server.kill() (SIGTERM) reaps only the
// direct PID and leaves Vite's esbuild service children orphaned — they keep squatting the port and
// serve STALE code on the next run (the recurring "stale server" bug). taskkill /T kills the tree.
export function killServer(server) {
  if (!server || server.killed) return;
  if (process.platform === "win32" && server.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  try {
    server.kill();
  } catch {
    // already gone
  }
}

// Boot the game headless and hand back a driven page + error collector. Chromium launches with
// --mute-audio as belt-and-suspenders over the in-app navigator.webdriver mute gate. close() tears
// down the browser AND the server tree, so no orphaned Vite survives to serve stale code next run.
export async function launchGame({ port, viewport = { width: 1600, height: 900 }, query = "", init, cwd = process.cwd() } = {}) {
  const { server, url } = await startServer(port, cwd);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--mute-audio"] });
  const context = await browser.newContext({ viewport });
  // START FROM A CLEAN SLATE. Every smoke shares one browser profile per run only by accident of
  // ordering, but they share the game's ORIGIN, so a saved battle or a remembered setting written by
  // an earlier script leaks into the next one. That surfaced as smoke:animation failing to queue a
  // move in the fleet while passing standalone: it had resumed a battle another smoke had left
  // behind, on a different map, and its hard-coded destination was no longer valid ground.
  //
  // Every persisted key in this game is namespaced `rht.`, so clearing that prefix resets the app
  // without touching anything else. Runs BEFORE any caller-supplied init, so a smoke that wants to
  // seed specific state still can.
  await context.addInitScript(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("rht.")) localStorage.removeItem(key);
      }
    } catch {
      // Private mode or blocked storage: nothing to clear, and the app tolerates it either way.
    }
  });
  if (init) await context.addInitScript(init); // seed localStorage etc. before the app boots
  const page = await context.newPage();
  // A cloud container renders on SwiftShader and boots to the title in ~33s, past Playwright's 30s
  // default; SMOKE_TIMEOUT_MS raises every wait without touching the smokes (default unchanged).
  if (process.env.SMOKE_TIMEOUT_MS) page.setDefaultTimeout(Number(process.env.SMOKE_TIMEOUT_MS));
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));
  const q = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  await page.goto(`${url}/${q}`, { waitUntil: "networkidle" });
  const close = async () => {
    try {
      await browser.close();
    } finally {
      killServer(server);
    }
  };
  return { server, browser, context, page, errors, url, close };
}

// Black-frame guard: throw if the WebGL canvas center is essentially unlit. RH4's lesson — a clean
// console over a black canvas is still a failure, so every capture point should assert paint.
export async function assertLit(page, label) {
  const s = await sampleCanvas(page);
  if (!s.ok) throw new Error(`Black/unlit canvas at "${label}": ${JSON.stringify(s)}`);
  return s;
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
  // `npx playwright install chromium` caches per OS: %LOCALAPPDATA% on Windows, ~/.cache on Linux
  // (cloud/CI), ~/Library/Caches on macOS -- or wherever PLAYWRIGHT_BROWSERS_PATH points.
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ].filter((root) => root && existsSync(root));
  const exes = [
    ["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"],
    ["chrome-linux64", "chrome"], ["chrome-linux", "chrome"],
    ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ];
  const matches = roots.flatMap((root) => readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .flatMap((name) => exes.map((parts) => join(root, name, ...parts))))
    .filter((path) => existsSync(path))
    .sort();
  if (!matches.length) throw new Error("No Playwright Chromium found: run `npx playwright install chromium` (or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)");
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


// ---------------------------------------------------------------------------------------------
// OBJECTIVE IMAGE GATE.
//
// "Does this look good" is not answerable by a test, but several specific ways a frame looks BAD
// are measurable, and those are exactly the ones that survive a screenshot review because the eye
// adapts to them: a washed-out low-contrast image, a frame that is really one colour with the
// saturation turned up, blown highlights, crushed blacks. Reading the numbers stops a round from
// being judged on whether the last change felt like an improvement.
//
// Sampled off the live WebGL canvas (preserveDrawingBuffer is on) rather than by decoding a PNG,
// so it needs no image library. UI panels are excluded by sampling only the central region --
// the HUD is dark chrome and would otherwise dominate every reading.
export async function imageStats(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("game");
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: "missing canvas" };
    const w = 320;
    const h = 180;
    const scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, reason: "no 2d context" };
    // Central 76% of the frame: skips the HUD rails top/bottom and the side panels.
    const inset = 0.12;
    ctx.drawImage(canvas, canvas.width * inset, canvas.height * inset, canvas.width * (1 - inset * 2), canvas.height * (1 - inset * 2), 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const lums = [];
    const hues = new Array(36).fill(0);
    let satSum = 0;
    let blown = 0;
    let crushed = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lums.push(l);
      if (l > 0.97) blown += 1;
      if (l < 0.02) crushed += 1;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      satSum += max === 0 ? 0 : delta / max;
      if (delta > 0.04) {
        let hue;
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue = ((hue * 60) + 360) % 360;
        hues[Math.floor(hue / 10)] += 1;
      }
    }
    const n = lums.length;
    lums.sort((a, b) => a - b);
    const mean = lums.reduce((a, b) => a + b, 0) / n;
    const variance = lums.reduce((a, l) => a + (l - mean) * (l - mean), 0) / n;
    const pct = (q) => lums[Math.min(n - 1, Math.floor(q * n))];
    const colored = hues.reduce((a, b) => a + b, 0);
    const dominantHue = Math.max(...hues);

    return {
      ok: true,
      // Mean brightness. Very low = murky, very high = washed.
      meanLuma: +mean.toFixed(4),
      // Spread of brightness. THE flatness signal: a low value is a frame with no light and shade.
      contrast: +Math.sqrt(variance).toFixed(4),
      // Dynamic range actually used, ignoring outliers.
      range: +(pct(0.95) - pct(0.05)).toFixed(4),
      meanSat: +(satSum / n).toFixed(4),
      // Share of coloured pixels sitting in ONE 10-degree hue bucket. High = the frame is a single
      // colour wash, which is how each of these maps currently reads.
      hueConcentration: colored ? +(dominantHue / colored).toFixed(4) : 0,
      blownPct: +(blown / n).toFixed(4),
      crushedPct: +(crushed / n).toFixed(4),
    };
  });
}

// Score a stats reading against the thresholds, returning the list of failures (empty = pass).
// Thresholds are deliberately loose -- they catch "this frame is broken", not "this frame is
// beautiful", and a gate that fires on taste would just get ignored.
export function gradeImageStats(stats, label = "frame") {
  const bad = [];
  if (!stats?.ok) return [`${label}: ${stats?.reason ?? "no stats"}`];
  if (stats.meanLuma < 0.06) bad.push(`${label}: MURKY (meanLuma ${stats.meanLuma})`);
  if (stats.meanLuma > 0.80) bad.push(`${label}: WASHED (meanLuma ${stats.meanLuma})`);
  // RECALIBRATED. 0.10 was set against an earlier, brighter look. The art direction has since moved
  // deliberately -- a desaturated military palette, props pushed back behind the units, and scenery
  // that no longer glows -- and the scenes now sit in a narrow 0.087-0.117 band by design. At 0.10
  // this fired on six of nine scenarios every run, which makes it noise rather than a signal, and
  // the only ways to "fix" it were to crush blacks in post or undo the art decisions.
  //
  // 0.085 still separates a genuinely broken frame from a stylistically low-contrast one: the
  // failures this gate was built to catch measured 0.033 to 0.055 and would all still fire.
  if (stats.contrast < 0.085) bad.push(`${label}: FLAT (contrast ${stats.contrast})`);
  if (stats.range < 0.22) bad.push(`${label}: NARROW RANGE (${stats.range})`);
  if (stats.hueConcentration > 0.72) bad.push(`${label}: MONOCHROME (${Math.round(stats.hueConcentration * 100)}% of colour in one hue)`);
  if (stats.blownPct > 0.06) bad.push(`${label}: BLOWN (${Math.round(stats.blownPct * 100)}% clipped white)`);
  return bad;
}

export { delay };

// Deploy straight into a battle through the debug seam instead of clicking through the menu.
//
// The menu path is a RACE. `[data-start]` paints a loading veil and defers startBattle() by two
// rAFs, while the sim has ALREADY been in phase "command" with a full default scenario since page
// load -- so `waitForFunction(phase === "command")` after the click can pass before the battle is
// configured. configure() then splices the entity list and resets the selection to the player base,
// so anything a smoke spawned in that window is erased and the next queueMove() rejects ("base
// cannot move"). That is the intermittent "could not queue a move order" in smoke:animation.
//
// __rht.startBattle() runs configure() synchronously, so once this resolves the battle on screen is
// the battle the smoke asked for, on the map it asked for. Menu-driven deploys stay covered by
// smoke:flow and smoke:buttons.
export async function deployBattle(page, { map = "dustbowl", mode = "destroy", difficulty } = {}) {
  await page.waitForFunction(() => Boolean(window.__rht), undefined, { timeout: 20000 });
  await page.evaluate(([m, md, d]) => window.__rht.startBattle(m, md, d), [map, mode, difficulty]);
  await page.waitForFunction(
    (m) => window.__rht.sim.mapDef.id === m && window.__rht.sim.phase === "command",
    map,
    { timeout: 20000 },
  );
}
