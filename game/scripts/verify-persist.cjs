// Proves localStorage survives an app restart under the stable app:// origin used by
// electron-main.cjs. Run twice with the SAME userData dir:
//   electron scripts/verify-persist.cjs write   (stores a value, exits)
//   electron scripts/verify-persist.cjs read    (reads it back, exits 0 if present)
// On the old random-port build the second launch saw a different origin and FAILED here.
const { app, BrowserWindow, protocol } = require("electron");
const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const mode = process.argv[2] === "read" ? "read" : "write";
const KEY = "rht.persisttest.v1";
const VALUE = "persisted-ok";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  protocol.handle("app", async (request) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === "/" || p === "") p = "/index.html";
    const resolved = path.resolve(path.join(distDir, p));
    if (!resolved.startsWith(path.resolve(distDir))) return new Response("Forbidden", { status: 403 });
    try {
      const data = await fs.promises.readFile(resolved);
      return new Response(data, { status: 200, headers: { "Content-Type": MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL("app://rht/index.html");

  if (mode === "write") {
    await win.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(VALUE)}); true`);
    console.log("WROTE", KEY);
    app.exit(0);
  } else {
    const got = await win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(KEY)})`);
    if (got === VALUE) {
      console.log("READ OK:", got, "— localStorage persisted across app restart");
      app.exit(0);
    } else {
      console.error("READ FAIL: expected", VALUE, "got", JSON.stringify(got));
      app.exit(1);
    }
  }
}).catch((e) => { console.error(e); app.exit(1); });
