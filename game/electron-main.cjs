const { app, BrowserWindow, Menu, screen, protocol } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const distDir = path.join(__dirname, "dist");
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
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

// Serve the built SPA from a STABLE custom origin (app://rht) instead of an http server on a
// random port. localStorage is partitioned by origin — scheme + host + PORT — so the old
// `server.listen(0)` handed every launch a brand-new origin and a fresh, empty store, silently
// wiping saved battles, settings, and progression on every quit. A fixed scheme keeps the origin
// constant across launches, so persistence survives exiting the game. Files are read and
// served with explicit MIME types so ES modules load with the correct Content-Type.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveAppProtocol() {
  protocol.handle("app", async (request) => {
    let pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    const resolved = path.resolve(path.join(distDir, pathname));
    if (!resolved.startsWith(path.resolve(distDir))) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(resolved);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

// PLAY LOG (owner 2026-10-01: "when I run the game locally ... sends logs to a file so afterwards
// when I make references to what happened while I tested you know what I mean"). Running from the
// repo (npm run desktop / standalone; never the packaged .exe) copies the page console -- the game's
// "[play]" trail of clicks, orders, refusals and errors, see src/debug/playLog.ts -- to
// game/logs/play-<time>.log and game/logs/latest.log. The last 20 sessions are kept.
// RHT_NO_PLAYLOG=1 turns it off.
let playLog = null;
function openPlayLog() {
  if (app.isPackaged || process.env.RHT_NO_PLAYLOG === "1") return;
  const dir = path.join(__dirname, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const old = fs.readdirSync(dir).filter((f) => /^play-.*\.log$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 19))) fs.rmSync(path.join(dir, f), { force: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `play-${stamp}.log`);
  const latest = path.join(dir, "latest.log");
  fs.writeFileSync(latest, "");
  playLog = (line) => {
    fs.appendFileSync(file, line + "\n");
    fs.appendFileSync(latest, line + "\n");
  };
  playLog(`# Rogue Heroes play log ${new Date().toString()} -> ${file}`);
}
function logLine(level, text) {
  if (!playLog) return;
  const t = new Date().toTimeString().slice(0, 8);
  playLog(`${t} ${level === "info" || level === "log" ? "" : level.toUpperCase() + " "}${text}`);
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1800, Math.floor(width * 0.82)),
    height: Math.min(1000, Math.floor(height * 0.82)),
    minWidth: 1000,
    minHeight: 650,
    title: "Rogue Heroes Tactics",
    backgroundColor: "#080a0d",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  // Electron 42 passes the details on the event; older builds passed (event, level, message).
  win.webContents.on("console-message", (event, legacyLevel, legacyMessage) => {
    const level = typeof event.level === "string" ? event.level : ["log", "warning", "error"][legacyLevel] ?? "log";
    logLine(level, event.message ?? legacyMessage ?? "");
  });
  win.webContents.on("render-process-gone", (_e, details) => logLine("error", `renderer gone: ${details.reason}`));
  win.webContents.on("unresponsive", () => logLine("error", "window unresponsive"));
  // RHT_HIDDEN=1: never show the window (scripted checks must not steal focus).
  if (process.env.RHT_HIDDEN !== "1") win.once("ready-to-show", () => win.show());
  // Launch with --debug (or RHT_DEBUG=1) to unlock the in-game Debug/Sandbox settings section.
  const debug = process.argv.includes("--debug") || process.env.RHT_DEBUG === "1";
  win.loadURL(`app://rht/index.html${debug ? "?debug" : ""}`);
  if (process.env.RHT_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });
}

// Use classic (non-overlay) scrollbars so the themed ::-webkit-scrollbar styling is always visible
// instead of an auto-hiding thin overlay bar. Must be set before the app is ready.
app.commandLine.appendSwitch("disable-features", "OverlayScrollbar");

app.whenReady().then(() => {
  serveAppProtocol();
  openPlayLog();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
