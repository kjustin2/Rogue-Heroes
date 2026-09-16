// REAL-GPU FRAME-TIME PROBE. Electron on the actual GPU, hidden window, background throttling off:
// stages the stress scenario, runs three resolves, and prints frame p50/p95/max plus draw work.
// Headless SwiftShader numbers say nothing about a 5070 Ti; this does. Run: npm run soak:gpu
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
if (!fs.existsSync(path.join(distDir, "index.html"))) { console.error("No dist/ — run npm run build"); process.exit(1); }
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
const SIG = `(() => { const out = new Set(); window.__rht.sceneRoot().traverse((o) => { if (!o.isMesh || !o.material) return; const m = o.material; out.add([m.type, !!m.map, !!m.normalMap, !!m.vertexColors, m.transparent, m.blending, m.side, m.depthTest, m.depthWrite, o.receiveShadow, !!o.isInstancedMesh, o.parent && o.parent.name || ''].join('|')); }); return [...out]; })()`;

app.whenReady().then(async () => {
  const { server, port } = await serve();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.showInactive();
  win.webContents.setAudioMuted(true);
  win.webContents.on("console-message", (e) => { if (e.level >= 2 || /warmUp/.test(e.message)) console.log("  page:", e.message.slice(0, 300)); });
  const js = (src) => win.webContents.executeJavaScript(src);
  const scenario = process.argv[2] || "stress";
  try {
    console.log("loading…"); await win.loadURL(`http://127.0.0.1:${port}/`); console.log("loaded");
    for (let i = 0; i < 100 && !(await js("Boolean(window.__rht)")); i += 1) await sleep(100);
    await js(`window.__rht.scenario(${JSON.stringify(scenario)})`);
    await sleep(2500);
    const gpu = await js("(() => { const gl = document.querySelector('canvas').getContext('webgl2'); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; })()");
    console.log("gpu:", gpu, "| scenario:", scenario);
    const report = async (label) => {
      const p = await js("window.__rht.perf()");
      console.log(`${label.padEnd(10)} fps ${String(p.fps).padStart(6)} · p50 ${p.frame.p50}ms · p95 ${p.frame.p95}ms · max ${p.frame.max}ms · jank ${(p.frame.jankRatio * 100).toFixed(0)}% · ${p.render.calls} calls · ${p.render.triangles} tris · programs ${p.render.programs}`);
      return p;
    };
    console.log("warm-up in scenario:", JSON.stringify(await js("window.__rht.warmUp()")));
    await js("window.__rht.perfReset()"); await sleep(3000); await report("command");
    for (let t = 0; t < 3; t += 1) {
      const before = new Set(await js("window.__rht.programs()"));
      const seenSigs = new Set(await js(SIG));
      const newSigs = new Set();
      await js("window.__rht.perfReset(); window.__rht.endTurn()");
      for (let i = 0; i < 300 && (await js("window.__rht.sim.phase")) === "resolve"; i += 1) {
        await sleep(100);
        if (i % 2 === 0) for (const sg of await js(SIG)) if (!seenSigs.has(sg)) newSigs.add(sg);
      }
      await report(`resolve ${t + 1}`);
      if (t === 0) for (const sg of newSigs) console.log("  resolve-only material:", sg);
      const after = await js("window.__rht.programs()");
      const fresh = after.filter((k) => !before.has(k));
      for (const k of fresh) {
        // Closest pre-existing key, and the fields that differ: names the variant without guessing.
        const a = k.split(","); let best = null; let bestDiff = Infinity;
        for (const other of before) { const b = other.split(","); if (b.length !== a.length) continue; const d = a.filter((v, i) => v !== b[i]).length; if (d < bestDiff) { bestDiff = d; best = b; } }
        const diffs = best ? a.map((v, i) => v !== best[i] ? `#${i}: ${best[i]}->${v}` : null).filter(Boolean) : ["(no same-length key)"];
        console.log("  compiled mid-resolve (" + a.length + " fields): differs from nearest by", diffs.join(" | "));
        console.log("    full:", k);
        const transparentTwins = [...before].filter((o) => o.split(",")[52] === "1027").length;
        console.log("    programs already at non-opaque mask before resolve:", transparentTwins);
        let tb = null, td = Infinity;
        for (const other of before) { const b = other.split(","); if (b[52] !== "1027" || b.length !== a.length) continue; const d = a.filter((v, i) => v !== b[i]).length; if (d < td) { td = d; tb = b; } }
        if (tb) console.log("    nearest NON-OPAQUE existing differs by:", a.map((v, i) => v !== tb[i] ? `#${i}: ${tb[i]}->${v}` : null).filter(Boolean).join(" | "));
      }
      await sleep(600);
    }
    const errs = await js("window.__rht.frameErrors()");
    console.log("frame errors:", errs);
  } catch (e) { console.error("soak failed:", e); process.exitCode = 1; }
  finally { server.close(); app.quit(); }
});
