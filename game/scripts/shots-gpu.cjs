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
      if (s === "tutorial") {
        // The first three beats a new player sees, straight from the title link.
        await js(`document.querySelector('[data-menu="tutorial"]').click()`);
        await sleep(3500);
        await shot("tutorial-1");
        await js(`(() => { const b = document.querySelector('.tutorial-next, [data-tutorial-next], .tutorial-card button'); if (b) b.click(); })()`);
        await sleep(1500);
        await shot("tutorial-2");
        continue;
      }
      if (s === "portrait") {
        // Three troopers close, three-quarter view: the detail test.
        await js(`window.__rht.startBattle("verdant", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; [["soldier", -1.4], ["heavy", 0], ["sniper", 1.4]].forEach(([k, x]) => { const u = sim.debugSpawn(k, "player", { x: x - 20, z: 0 }); u.yaw = Math.PI + 0.4; }); window.__rht.deselect(); })()`);
        await sleep(2500);
        await js(`window.__rht.setView({ x: -20, z: -0.9, zoom: 0.24, pitch: 0.42, yaw: 0.5 })`);
        await sleep(600);
        await shot("portrait");
        continue;
      }
      if (s === "abilities") {
        // Smoke cloud, a marked enemy, a downed trooper beside a medic: the three new cues in one frame.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim;
          sim.smokeClouds.push({ id: "smoke-shot", x: -4, z: 0, radius: 3, turnsLeft: 3 });
          const e = sim.debugSpawn("soldier", "enemy", { x: 3, z: -1 }); e.yaw = 2.6; e.markedUntilTurn = sim.turn + 1;
          const m = sim.debugSpawn("medic", "player", { x: 1, z: 2 }); m.yaw = 0.4;
          const d = sim.debugSpawn("scout", "player", { x: 2.4, z: 2.4 }); d.yaw = 0.2; d.downed = true; d.stance = "prone";
          window.__rht.deselect(); })()`);
        await sleep(2500);
        await js(`window.__rht.setView({ x: 0, z: 0.6, zoom: 0.4, pitch: 0.55, yaw: 0.3 })`);
        await sleep(600);
        await shot("abilities");
        continue;
      }
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
