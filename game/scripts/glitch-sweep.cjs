// MEASURED REAL-GPU GLITCH SWEEP (reports only; changes no game code).
//
// Hidden Electron window on the real GPU, full post chain, serving the built dist/ the same way
// shots:gpu does. Captures CONSECUTIVE frames with the camera hard-pinned each frame, diffs
// neighbours (absdiff > THRESH), counts changed pixels per 32px cell, and classifies each hot cell
// as SPECKLE (isolated changed pixels = z-fight / shimmer / outline flicker) or COHERENT (a blob =
// real animation). Crops the hottest cells from both frames of the pair so a human can READ them.
//
//   npx electron scripts/glitch-sweep.cjs [idle|resolve|pan|static|all]
//
// Everything lands in shots/glitch/ ; per-scene numbers also go to shots/glitch/report.json.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const http = require("http");
const path = require("path");
const sharp = require("sharp");

const distDir = path.join(__dirname, "..", "dist");
const outDir = path.join(__dirname, "..", "shots", "glitch");
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
const MAPS = ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"];
const CELL = 32;
const THRESH = 14;
const HOT = 24;
const phases = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!phases.length) phases.push("all");
const want = (p) => phases.includes("all") || phases.includes(p);
const report = [];

async function raw(buf) {
  const img = sharp(buf).removeAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}
// Diff two raw frames: per-cell changed-pixel count + speckle ratio (changed pixels with no
// changed 4-neighbour). Speckle is the z-fight / shimmer signature; a moving object is coherent.
function diffCells(a, b) {
  const { w, h, ch } = a;
  const mask = new Uint8Array(w * h);
  let total = 0;
  for (let i = 0, p = 0; i < w * h; i += 1, p += ch) {
    const d = Math.max(Math.abs(a.data[p] - b.data[p]), Math.abs(a.data[p + 1] - b.data[p + 1]), Math.abs(a.data[p + 2] - b.data[p + 2]));
    if (d > THRESH) { mask[i] = 1; total += 1; }
  }
  const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
  const cells = [];
  for (let cy = 0; cy < rows; cy += 1) for (let cx = 0; cx < cols; cx += 1) {
    let n = 0, iso = 0;
    const x0 = cx * CELL, y0 = cy * CELL, x1 = Math.min(x0 + CELL, w), y1 = Math.min(y0 + CELL, h);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const i = y * w + x;
      if (!mask[i]) continue;
      n += 1;
      const nb = (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w]);
      if (!nb) iso += 1;
    }
    if (n >= HOT) cells.push({ cx, cy, x: x0, y: y0, n, speckle: +(iso / n).toFixed(2) });
  }
  cells.sort((p, q) => q.n - p.n);
  return { total, pct: +((total / (w * h)) * 100).toFixed(3), cells, w, h };
}

// Crop the hottest cells from BOTH frames of the pair, side by side, 3x, so they can be read.
async function cropHot(name, frames, cells, pairIdx, count = 3) {
  const paths = [];
  for (let k = 0; k < Math.min(count, cells.length); k += 1) {
    const c = cells[k];
    const S = 128, Z = 3;
    const meta = await sharp(frames[pairIdx]).metadata();
    const left = Math.max(0, Math.min(meta.width - S, c.x - (S - CELL) / 2));
    const top = Math.max(0, Math.min(meta.height - S, c.y - (S - CELL) / 2));
    const reg = { left: Math.round(left), top: Math.round(top), width: S, height: S };
    const a = await sharp(frames[pairIdx]).extract(reg).resize(S * Z, S * Z, { kernel: "nearest" }).png().toBuffer();
    const b = await sharp(frames[pairIdx + 1]).extract(reg).resize(S * Z, S * Z, { kernel: "nearest" }).png().toBuffer();
    const file = path.join(outDir, name + "-hot" + (k + 1) + ".png");
    await sharp({ create: { width: S * Z * 2 + 12, height: S * Z, channels: 3, background: "#101010" } })
      .composite([{ input: a, left: 0, top: 0 }, { input: b, left: S * Z + 12, top: 0 }]).png().toFile(file);
    paths.push({ file, at: reg, n: c.n, speckle: c.speckle });
  }
  return paths;
}
async function contactSheet(name, frames, cols = 4, tw = 400) {
  const th = Math.round(tw * 9 / 16);
  const tiles = await Promise.all(frames.map((b) => sharp(b).resize(tw, th).png().toBuffer()));
  const rows = Math.ceil(tiles.length / cols);
  const file = path.join(outDir, name + "-sheet.png");
  await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: "#000" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % cols) * tw, top: Math.floor(i / cols) * th }))).png().toFile(file);
  return file;
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.showInactive();
  win.webContents.setAudioMuted(true);
  const js = (src) => win.webContents.executeJavaScript(src);
  const cap = async () => (await win.webContents.capturePage()).toPNG();
  const shot = async (name) => { const b = await cap(); fs.writeFileSync(path.join(outDir, name + ".png"), b); console.log("  shot " + name + ".png"); return b; };
  const pin = (v) => js("window.__rht.setView(" + JSON.stringify(v) + ")");

  async function burst(view, n, gap) {
    const frames = [];
    for (let i = 0; i < n; i += 1) { if (view) await pin(view); if (gap) await sleep(gap); frames.push(await cap()); }
    return frames;
  }
  // Diff every neighbouring pair; keep the MEDIAN pair (a one-off settle frame must not be the
  // finding) and report the worst for reading.
  async function measure(name, frames, note) {
    const raws = [];
    for (const f of frames) raws.push(await raw(f));
    const pairs = [];
    for (let i = 0; i + 1 < raws.length; i += 1) pairs.push(Object.assign({ i }, diffCells(raws[i], raws[i + 1])));
    const sorted = pairs.slice().sort((a, b) => a.total - b.total);
    const med = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    const speckleCells = med.cells.filter((c) => c.speckle >= 0.35);
    const crops = await cropHot(name, frames, med.cells, med.i);
    const sheetFile = frames.length >= 4 ? await contactSheet(name, frames) : null;
    report.push({ scene: name, note: note || "", medianChangedPct: med.pct, worstChangedPct: worst.pct,
      hotCells: med.cells.length, speckleCells: speckleCells.length, topCells: med.cells.slice(0, 5), crops, sheet: sheetFile });
    console.log("  " + name + ": median " + med.pct + "% changed, " + med.cells.length + " hot cells (" + speckleCells.length + " speckly), worst " + worst.pct + "%");
    if (med.cells.length) console.log("    top: " + med.cells.slice(0, 3).map((c) => "(" + c.x + "," + c.y + ") n=" + c.n + " spk=" + c.speckle).join("  "));
  }

  try {
    await win.loadURL("http://127.0.0.1:" + port + "/");
    for (let i = 0; i < 100 && !(await js("Boolean(window.__rht)")); i += 1) await sleep(100);
    await sleep(3000);

    // ---- 1. COMMAND-PHASE IDLE on every map (sim static; only render animation may move) ----
    if (want("idle")) {
      for (const map of MAPS) {
        console.log("idle: " + map);
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3500);
        const view = { x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 };
        await pin(view); await sleep(1200);
        const frames = await burst(view, 8, 0);
        fs.writeFileSync(path.join(outDir, "idle-" + map + "-a.png"), frames[3]);
        await measure("idle-" + map, frames, "command phase, deselected, gameplay zoom 0.8");
      }
    }

    // ---- 2. RESOLVE on three scenarios (camera pinned) ----
    if (want("resolve")) {
      for (const scen of ["firefight", "siege", "high-ground"]) {
        console.log("resolve: " + scen);
        const ok = await js("window.__rht.scenario(" + JSON.stringify(scen) + ")");
        if (!ok) { console.log("  scenario missing, skipping"); continue; }
        await js("window.__rht.deselect()");
        await sleep(2500);
        const view = { zoom: 0.72, pitch: 0.6, yaw: 0.25 };
        await pin(view); await sleep(600);
        await js("window.__rht.setResolveScale(0.5); window.__rht.endTurn();");
        await sleep(1200);
        const frames = await burst(view, 12, 0);
        await js("window.__rht.setResolveScale(1)");
        await measure("resolve-" + scen, frames, "mid-resolve, camera pinned, resolveScale 0.5");
        await sleep(3000);
      }
    }

    // ---- 3. PAN + ZOOM sweep (shadow-map crawl, ground-detail pop, overlay flicker) ----
    if (want("pan")) {
      for (const map of ["dustbowl", "karak"]) {
        console.log("pan: " + map);
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3500);
        const base = { x: -6, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 };
        await pin(base); await sleep(1200);
        const ref = await cap();
        const panFrames = [];
        for (let i = 0; i < 12; i += 1) { await pin({ x: base.x + i * 0.12, z: base.z, zoom: base.zoom, pitch: base.pitch, yaw: base.yaw }); await sleep(60); panFrames.push(await cap()); }
        await contactSheet("pan-" + map, panFrames);
        const strip = [];
        for (const b of panFrames.slice(0, 6)) strip.push(await sharp(b).extract({ left: 500, top: 380, width: 260, height: 200 }).resize(520, 400, { kernel: "nearest" }).png().toBuffer());
        await sharp({ create: { width: 520 * 3, height: 400 * 2, channels: 3, background: "#000" } })
          .composite(strip.map((input, i) => ({ input, left: (i % 3) * 520, top: Math.floor(i / 3) * 400 }))).png()
          .toFile(path.join(outDir, "pan-" + map + "-crop.png"));
        // RETURN-TO-VIEW determinism: the exact starting view again.
        await pin(base); await sleep(900);
        const back = await cap();
        const d = diffCells(await raw(ref), await raw(back));
        const crops = await cropHot("pan-return-" + map, [ref, back], d.cells, 0);
        report.push({ scene: "pan-return-" + map, note: "same view before/after a pan", medianChangedPct: d.pct, hotCells: d.cells.length, speckleCells: d.cells.filter((c) => c.speckle >= 0.35).length, topCells: d.cells.slice(0, 5), crops });
        console.log("  pan-return-" + map + ": " + d.pct + "% changed, " + d.cells.length + " hot cells");
        const zoomFrames = [];
        for (let i = 0; i < 10; i += 1) { await pin({ x: 0, z: base.z, zoom: 1.5 - i * 0.13, pitch: base.pitch, yaw: base.yaw }); await sleep(140); zoomFrames.push(await cap()); }
        await contactSheet("zoom-" + map, zoomFrames, 5, 320);
        console.log("  zoom-" + map + "-sheet.png written");
      }
    }

    // ---- 4. STATIC per map: gameplay zoom + TRUE max zoom-out (wheel path) + a close pass ----
    if (want("static")) {
      for (const map of MAPS) {
        console.log("static: " + map);
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3500);
        await pin({ x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 }); await sleep(900);
        await shot("static-" + map + "-play");
        await js("(() => { const c = document.querySelector('canvas'); for (let i = 0; i < 40; i += 1) c.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, clientX: 800, clientY: 450 })); })()");
        await sleep(1500);
        console.log("  zoomed out to " + (await js("JSON.stringify(window.__rht.viewState())")));
        await shot("static-" + map + "-zoomout");
        await js("(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === 'player' && e.kind === 'base'); if (hq) window.__rht.setView({ x: hq.position.x, z: hq.position.z, zoom: 0.33, pitch: 0.42, yaw: 0.6 }); })()");
        await sleep(1200);
        await shot("static-" + map + "-close");
      }
    }
  } catch (e) { console.error("sweep failed:", e); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(outDir, "report-" + phases.join("-") + ".json"), JSON.stringify(report, null, 2));
    console.log("report -> shots/glitch/report-" + phases.join("-") + ".json");
    server.close(); app.quit();
  }
});
