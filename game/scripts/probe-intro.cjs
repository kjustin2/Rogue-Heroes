// REAL-GPU steadiness probe for the opening shot: boots the built dist/ in a hidden Electron window
// and logs, per rAF from the first frame, the frame time and the camera's second difference (a
// shake is a large second difference; a smooth drift is ~0). Fails above 0.2 -- the boot
// "earthquake" (a negative first-frame dt run through the trauma decay) measured 1.48.
// Run: npm run probe:intro
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const distDir = path.join(__dirname, "..", "dist");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".glb": "model/gltf-binary", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".json": "application/json" };
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
    fs.readFile(path.join(distDir, p), (err, data) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(data); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  win.webContents.setAudioMuted(true);
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const log = await win.webContents.executeJavaScript(`new Promise((done) => {
    const out = []; const t0 = performance.now(); let prev = [];
    const tick = () => {
      const cam = window.__rht && window.__rht.cameraObject && window.__rht.cameraObject();
      if (cam) {
        const p = [cam.position.x, cam.position.y, cam.position.z];
        prev.push(p); if (prev.length > 3) prev.shift();
        const j = prev.length === 3 ? Math.hypot(...[0,1,2].map((k) => prev[2][k] - 2*prev[1][k] + prev[0][k])) : 0;
        out.push([Math.round(performance.now() - t0), j.toFixed(4)]);
      }
      if (performance.now() - t0 < 5000) requestAnimationFrame(tick); else done(out);
    };
    requestAnimationFrame(tick);
  })`);
  const worst = log.reduce((w, r) => (Number(r[1]) > Number(w[1]) ? r : w), [0, "0"]);
  const ok = Number(worst[1]) < 0.2;
  console.log(`${ok ? "OK" : "FAIL"} probe:intro -- ${log.length} frames, worst camera jitter ${worst[1]} at ${worst[0]}ms`);
  app.exit(ok ? 0 : 1);
});
