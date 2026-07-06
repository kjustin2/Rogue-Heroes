const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const shotDir = path.join(__dirname, "..", "shots");
fs.mkdirSync(shotDir, { recursive: true });

if (!fs.existsSync(path.join(distDir, "index.html"))) {
  console.error("No dist/ build found. Run `npm run build` first.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

let server = null;
const errors = [];

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
      const resolved = path.resolve(path.join(distDir, urlPath));
      if (!resolved.startsWith(path.resolve(distDir))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      fs.readFile(resolved, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = `electron-${name}.png`;
  fs.writeFileSync(path.join(shotDir, file), image.toPNG());
  console.log("shot:", file);
}

async function run() {
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    show: false,
    backgroundColor: "#080a0d",
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // ponytail: showInactive paints real frames for capturePage() without stealing
  // focus from the editor/terminal. Plain show:true yanked focus on every smoke run.
  win.showInactive();
  // Tests run MUTED — no music/sfx blaring during background runs. Electron drives via
  // executeJavaScript (not a webdriver), so the in-app navigator.webdriver mute gate does not
  // apply here; mute at the Electron layer instead.
  win.webContents.setAudioMuted(true);

  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(`CONSOLE: ${event.message}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => errors.push(`RENDERER GONE: ${details.reason}`));
  win.webContents.on("unresponsive", () => errors.push("UNRESPONSIVE"));

  const js = (source) => win.webContents.executeJavaScript(source);
  const click = (selector) => js(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  const waitForSelector = (selector, label) =>
    waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), label);
  const clickRequired = async (selector, label) => {
    await waitForSelector(selector, label);
    const ok = await click(selector);
    if (!ok) throw new Error(`Missing ${label}: ${selector}`);
    await sleep(120);
  };

  try {
    await win.loadURL(`http://127.0.0.1:${port}/`);
    await waitFor(() => js("Boolean(window.__rht && document.querySelector('.main-menu'))"), "menu boot", 20000);
    await shot(win, "menu");

    // Hero GLBs (incl. the winter skin pack) must be served with a real model MIME.
    const glb = await js(`fetch('/models/tank-winter.glb').then(r => ({ ok: r.ok, type: r.headers.get('content-type') }))`);
    if (!glb.ok || !/model\\/gltf-binary/.test(glb.type || "")) {
      throw new Error(`GLB serving broken: ${JSON.stringify(glb)}`);
    }

    // Real player path: menu -> map pick -> battle.
    await clickRequired('[data-menu="play"]', "play button");
    await clickRequired('[data-map="dustbowl"]', "map card");
    await clickRequired("[data-start]", "start button");
    await waitFor(() => js("window.__rht.sim.phase === 'command'"), "command phase", 15000);
    await assertCanvasPainted(js, "electron command");
    await shot(win, "command");

    // Queue a shot and watch the resolve play out.
    await js(`(() => {
      const sim = window.__rht.sim;
      const shooter = sim.debugSpawn("soldier", "player", { x: -2, z: 0 });
      const target = sim.debugSpawn("soldier", "enemy", { x: 2, z: 0 });
      sim.debugSelect(shooter.id);
      sim.queueShootPart(target.id, "body");
      window.__rht.endTurn();
    })()`);
    await waitFor(() => js("window.__rht.sim.phase === 'resolve'"), "resolve phase", 5000);
    await assertCanvasPainted(js, "electron resolve");
    await shot(win, "resolve");
    await waitFor(() => js("window.__rht.sim.phase === 'command'"), "return to command", 30000);

    if (errors.length) throw new Error(errors.slice(0, 12).join("\n"));
    console.log("Electron smoke passed: menu, GLB MIME, battle start, resolve round-trip");
  } finally {
    win.destroy();
    if (server) server.close();
  }
}

async function assertCanvasPainted(js, label) {
  const sample = await js(`(() => {
    const canvas = document.getElementById("game");
    if (!(canvas instanceof HTMLCanvasElement)) return { ok: false, reason: "missing canvas" };
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
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
  })()`);
  if (!sample.ok) throw new Error(`Canvas pixel check failed for ${label}: ${JSON.stringify(sample)}`);
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    if (server) server.close();
    app.exit(1);
  });
