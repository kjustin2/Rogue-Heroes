// REAL-GPU SCREENSHOTS. Same hidden Electron window as soak:gpu, on the actual GPU with the full
// post chain, capturing each scenario at gameplay zoom to shots/gpu-<scenario>.png. SwiftShader
// shots are for gates; these are what the owner sees. Run: npm run shots:gpu -- firefight siege
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const distDir = path.join(__dirname, "..", "dist");
const MIME = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".glb": "model/gltf-binary", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml" };
const serve = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]); if (p === "/") p = "/index.html";
    const file = path.resolve(path.join(distDir, p));
    if (!file.startsWith(path.resolve(distDir))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(data); });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenarios = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!scenarios.length) scenarios.push("menu", "firefight", "high-ground", "siege", "base-defense", "lineup");

app.whenReady().then(async () => {
  const { server, port } = await serve();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.showInactive();
  win.webContents.setAudioMuted(true);
  const js = (src) => win.webContents.executeJavaScript(src);
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, "..", "shots", `gpu-${name}.png`), img.toPNG()); console.log("shot: gpu-" + name + ".png"); };
  try {
    await win.loadURL(`http://127.0.0.1:${port}/`);
    for (let i = 0; i < 100 && !(await js("Boolean(window.__rht)")); i += 1) await sleep(100);
    await sleep(3000);
    for (const s of scenarios) {
      if (s === "menu") { await shot("menu"); continue; }
      if (s === "lineup") {
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; ["soldier","scout","sniper","striker","heavy","grenadier","mortar","medic","engineer","flamer","droneop","sapper","jumper"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -9 + i * 1.5, z: 0 }); u.yaw = 0.5; }); window.__rht.deselect(); })()`);
        await sleep(2500);
        await js(`window.__rht.setView({ x: 0, z: 0.6, zoom: 0.34, pitch: 0.5, yaw: 0.35 })`);
        await sleep(600);
        await shot("lineup");
        continue;
      }
      await js(`window.__rht.scenario(${JSON.stringify(s)}); window.__rht.deselect();`);
      await sleep(1800);
      await js(`window.__rht.setView({ zoom: 0.75, pitch: 0.62, yaw: 0.2 })`);
      await sleep(900);
      await shot(s);
    }
  } catch (e) { console.error("shots failed:", e); process.exitCode = 1; }
  finally { server.close(); app.quit(); }
});
