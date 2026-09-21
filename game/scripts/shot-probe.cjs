// Ad-hoc real-GPU probe: SHOT_SPEC='map|x|z|zoom|pitch|yaw|name;...' npm run shot:probe
const { app, BrowserWindow } = require("electron");
const fs = require("fs"); const http = require("http"); const path = require("path");
const distDir = path.join(__dirname, "..", "dist");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary", ".woff2": "font/woff2" };
const serve = () => new Promise((resolve) => { const server = http.createServer((req, res) => { let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html"; const file = path.resolve(path.join(distDir, p)); fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(data); }); }); server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const { server, port } = await serve();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.showInactive(); win.webContents.setAudioMuted(true);
  const js = (src) => win.webContents.executeJavaScript(src);
  try {
    await win.loadURL(`http://127.0.0.1:${port}/`);
    for (let i = 0; i < 100 && !(await js("Boolean(window.__rht)")); i += 1) await sleep(100);
    await sleep(2500);
    let current = "";
    for (const spec of (process.env.SHOT_SPEC || "").split(";").filter(Boolean)) {
      const [map, x, z, zoom, pitch, yaw, name] = spec.split("|");
      if (map !== current) { await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal"); window.__rht.deselect();`); await sleep(3000); current = map; await js(`document.querySelectorAll('.toast, .hint, [data-toast]').forEach((e) => e.remove())`); }
      if (process.env.SHOT_EVAL) console.log("eval:", JSON.stringify(await js(process.env.SHOT_EVAL)));
      await js(`window.__rht.setView({ x: ${x}, z: ${z}, zoom: ${zoom}, pitch: ${pitch}, yaw: ${yaw}, overview: true })`);
      await sleep(800);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, "..", "shots", `probe-${name}.png`), img.toPNG());
      console.log("shot: probe-" + name + ".png");
    }
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close(); app.quit();
});
