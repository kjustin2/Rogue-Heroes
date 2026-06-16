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
    show: true,
    backgroundColor: "#080a0d",
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

  try {
    await win.loadURL(`http://127.0.0.1:${port}/`);
    await waitFor(() => js("Boolean(window.__rht && document.querySelector('.topbar'))"), "game boot");
    await assertCanvasPainted(js, "electron command");
    await shot(win, "command");

    await click('[data-select="e-tank-1"]');
    await click('.part-choice[data-part="left-tread"]');
    await click('[data-confirm="shoot"]');
    const queued = await js("window.__rht.sim.orders.map((order) => ({ actorId: order.actorId, targetId: order.targetId, kind: order.kind }))");
    if (queued.length !== 1 || queued[0].targetId !== "e-tank-1" || queued[0].kind !== "shoot") {
      throw new Error(`Electron HUD targeting failed: ${JSON.stringify(queued)}`);
    }

    await js(`(() => {
      const api = window.__rht;
      const sim = api.sim;
      api.reset();
      for (const entity of sim.entities) {
        if (entity.team === "neutral") {
          entity.position.x = 0;
          entity.position.z = 8;
        }
      }
      const placements = new Map([
        ["p-tank-1", { x: -5, z: 0 }],
        ["p-soldier-1", { x: -5, z: -2.4 }],
        ["p-soldier-2", { x: -5, z: 2.4 }],
        ["e-tank-1", { x: 1.2, z: 0 }],
        ["e-soldier-1", { x: 1.2, z: -2.4 }],
        ["e-base-1", { x: 1.2, z: 2.4 }],
      ]);
      for (const [id, position] of placements) {
        const entity = sim.entity(id);
        entity.position.x = position.x;
        entity.position.z = position.z;
      }
      for (const enemy of sim.entities.filter((entity) => entity.team === "enemy")) {
        const critical = enemy.parts.find((part) => part.critical);
        critical.hp = Math.min(critical.hp, 10);
      }
      sim.select("p-tank-1");
      sim.queueShootPart("e-tank-1", "hull");
      sim.select("p-soldier-1");
      sim.queueShootPart("e-soldier-1", "head");
      sim.select("p-soldier-2");
      sim.queueShootPart("e-base-1", "core");
      api.endTurn();
    })()`);

    await waitFor(() => js("window.__rht.sim.phase === 'victory'"), "victory");
    await assertCanvasPainted(js, "electron victory");
    await shot(win, "victory");

    if (errors.length) throw new Error(errors.slice(0, 12).join("\n"));
    console.log("Electron smoke passed");
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
