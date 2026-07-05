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
  win.once("ready-to-show", () => win.show());
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
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
