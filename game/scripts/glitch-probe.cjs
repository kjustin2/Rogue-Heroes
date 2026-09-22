// Targeted probes for the glitch sweep. Bisects by toggling ONE thing at runtime (no code change)
// and measuring what disappears.  npx electron scripts/glitch-probe.cjs <probe> [args]
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
const probe = process.argv[2] || "particles";
const arg = process.argv[3];
async function raw(buf) { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height, ch: info.channels }; }
// Connected components over the changed-pixel mask; returns bboxes sorted by area.
function blobs(a, b, thresh) {
  const { w, h, ch } = a; const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i += 1, p += ch) {
    const d = Math.max(Math.abs(a.data[p] - b.data[p]), Math.abs(a.data[p + 1] - b.data[p + 1]), Math.abs(a.data[p + 2] - b.data[p + 2]));
    if (d > thresh) mask[i] = 1;
  }
  const seen = new Uint8Array(w * h); const out = []; const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || seen[i]) continue;
    stack.length = 0; stack.push(i); seen[i] = 1;
    let n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    while (stack.length) {
      const j = stack.pop(); const x = j % w, y = (j / w) | 0;
      n += 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    out.push({ n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, fill: +(n / ((x1 - x0 + 1) * (y1 - y0 + 1))).toFixed(2) });
  }
  out.sort((p, q) => q.n - p.n);
  return out;
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, port } = await serve();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.showInactive(); win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  const cap = async () => (await win.webContents.capturePage()).toPNG();
  const save = (n, b) => { fs.writeFileSync(path.join(outDir, n + ".png"), b); console.log("  " + n + ".png"); };
  try {
    await win.loadURL("http://127.0.0.1:" + port + "/");
    for (let i = 0; i < 100 && !(await js("Boolean(window.__rht)")); i += 1) await sleep(100);
    await sleep(3000);

    if (probe === "particles") {
      // The ambient bed (PointsMaterial, no map) on every map: toggle it off and measure exactly
      // what vanishes. The biggest changed blob IS the biggest particle on screen.
      for (const map of (arg ? [arg] : ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"])) {
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3500);
        // zoom 0.62 = the CLOSEST the interactive wheel clamp lets a player get.
        await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.62, pitch: 0.55, yaw: 0.2 })");
        await sleep(1500);
        const info = await js("(() => { const out = []; window.__rht.sceneObject().traverse((o) => { if (o.isPoints) out.push({ name: o.name, mat: o.material.type, size: o.material.size, map: !!o.material.map, alphaTest: o.material.alphaTest, opacity: o.material.opacity, count: o.geometry.getAttribute('position').count, attn: o.material.sizeAttenuation }); }); return JSON.stringify(out); })()");
        console.log(map + " points objects: " + info);
        const a = await cap();
        await js("window.__rht.sceneObject().traverse((o) => { if (o.isPoints && o.material.type === 'PointsMaterial') o.visible = false; })");
        await sleep(400);
        const b = await cap();
        const bl = blobs(await raw(a), await raw(b), 18);
        const squares = bl.filter((x) => x.n >= 9 && x.fill > 0.85 && Math.abs(x.w - x.h) <= Math.max(2, x.w * 0.25));
        console.log("  " + map + ": " + bl.length + " blobs vanished; biggest " + (bl[0] ? bl[0].w + "x" + bl[0].h + "px fill=" + bl[0].fill : "none") +
          "; square-shaped >=3px: " + squares.length + " (largest " + (squares[0] ? squares[0].w + "x" + squares[0].h : "-") + ")");
        save("particles-" + map + "-on", a); save("particles-" + map + "-off", b);
        if (bl[0]) {
          const S = Math.max(48, bl[0].w * 3), Z = 6;
          const left = Math.max(0, Math.min(1600 - S, bl[0].x - (S - bl[0].w) / 2)), top = Math.max(0, Math.min(900 - S, bl[0].y - (S - bl[0].h) / 2));
          const reg = { left: Math.round(left), top: Math.round(top), width: S, height: S };
          const ca = await sharp(a).extract(reg).resize(S * Z, S * Z, { kernel: "nearest" }).png().toBuffer();
          const cb = await sharp(b).extract(reg).resize(S * Z, S * Z, { kernel: "nearest" }).png().toBuffer();
          await sharp({ create: { width: S * Z * 2 + 10, height: S * Z, channels: 3, background: "#101010" } })
            .composite([{ input: ca, left: 0, top: 0 }, { input: cb, left: S * Z + 10, top: 0 }]).png()
            .toFile(path.join(outDir, "particles-" + map + "-biggest.png"));
          console.log("  particles-" + map + "-biggest.png (on | off) at " + JSON.stringify(reg));
        }
      }
    }

    if (probe === "pickup") {
      // Does the cash-cache coin/ring sink into the ground AS DRAWN? The coin is placed off the SIM
      // height (terrainHeightAt); the ground is drawn at visualGroundAt (talus + plate lift).
      for (const map of (arg ? [arg] : ["causeway", "ironworks", "verdant"])) {
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3500);
        const p = await js("(() => { const s = window.__rht.sim; const c = s.pickups && s.pickups[0]; return c ? JSON.stringify({ id: c.id, x: c.x, z: c.z }) : ''; })()");
        if (!p) { console.log(map + ": no pickups"); continue; }
        const c = JSON.parse(p);
        console.log(map + " pickup " + c.id + " at " + c.x.toFixed(2) + "," + c.z.toFixed(2));
        await js("window.__rht.setView({ x: " + c.x + ", z: " + (c.z + 1.2) + ", zoom: 0.62, pitch: 0.35, yaw: 0.3 })");
        await sleep(1200);
        // 10 consecutive frames across a full bob cycle (period 2pi/0.005ms = 1.26s).
        const frames = []; for (let i = 0; i < 10; i += 1) { frames.push(await cap()); await sleep(130); }
        const tiles = []; for (const f of frames) tiles.push(await sharp(f).extract({ left: 660, top: 300, width: 280, height: 260 }).resize(560, 520, { kernel: "nearest" }).png().toBuffer());
        await sharp({ create: { width: 560 * 5, height: 520 * 2, channels: 3, background: "#000" } })
          .composite(tiles.map((input, i) => ({ input, left: (i % 5) * 560, top: Math.floor(i / 5) * 520 }))).png()
          .toFile(path.join(outDir, "pickup-" + map + "-bob.png"));
        console.log("  pickup-" + map + "-bob.png (10 frames across the bob)");
        // The numbers: coin world Y vs the ground the renderer draws under it.
        console.log("  " + await js("(() => { const out = []; window.__rht.sceneObject().traverse((o) => { if (o.userData && o.userData.pickupId && o.geometry && o.geometry.type === 'OctahedronGeometry') { o.geometry.computeBoundingBox(); out.push({ id: o.userData.pickupId, y: +o.position.y.toFixed(3), bottom: +(o.position.y + o.geometry.boundingBox.min.y).toFixed(3) }); } }); return JSON.stringify(out); })()"));
      }
    }

    if (probe === "screenpick") {
      // What object is at screen pixel (x,y)? Raycasts the live scene through the live camera.
      const [map, sx, sy, view] = [arg, +process.argv[4], +process.argv[5], process.argv[6]];
      await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      if (view) { await js("window.__rht.setView(" + view + ")"); await sleep(1200); }
      save("screenpick-" + map, await cap());
      console.log(await js("(() => { const THREE = window.__THREE; return 'no-three'; })()"));
      console.log("hits: " + await js("(() => { const cam = window.__rht.cameraObject(); const root = window.__rht.sceneObject();" +
        " const ndc = { x: (" + sx + " / window.innerWidth) * 2 - 1, y: -((" + sy + " / window.innerHeight) * 2 - 1) };" +
        " const dir = cam.getWorldDirection ? null : null;" +
        " const out = []; root.traverse((o) => { if (!o.isMesh || !o.visible) return; const v = o.getWorldPosition(new o.position.constructor()); const pr = v.clone().project(cam);" +
        " if (Math.abs(pr.x - ndc.x) < 0.035 && Math.abs(pr.y - ndc.y) < 0.055 && pr.z < 1) out.push({ name: o.name || '(anon)', geo: o.geometry.type, mat: o.material.type, color: o.material.color && o.material.color.getHexString(), y: +v.y.toFixed(2), parent: o.parent && (o.parent.name || o.parent.type), pr: [+pr.x.toFixed(3), +pr.y.toFixed(3)] }); });" +
        " return JSON.stringify(out.slice(0, 25)); })()"));
    }

    if (probe === "shadowzoom") {
      // SHADOW_RADIUS is a FIXED 42 world units (stage.ts:56) while the interactive wheel clamp
      // lets the player zoom out to 2.6. Anything outside the 42-unit window samples the shadow
      // map's CLAMPED BORDER texel, which smears as flat grey regions + long straight streaks.
      // Bisection: capture with the key light casting, then with castShadow = false, at each zoom.
      const map = arg || "dustbowl";
      await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      for (const zoom of [0.8, 1.2, 1.6, 2.0, 2.6]) {
        await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.62, pitch: 0.6, yaw: 0.2 })"); await sleep(500);
        // debugSetView CLAMPS zoom to 1.55; the interactive wheel clamp goes to 2.6. Drive the
        // wheel so the framing is one a player can actually reach.
        await js("(() => { const c = document.querySelector('canvas'); const n = Math.round((" + zoom + " - 0.62) / 0.05); for (let i = 0; i < n; i += 1) c.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, clientX: 800, clientY: 450 })); })()");
        await sleep(1500);
        console.log("  actual view " + (await js("JSON.stringify(window.__rht.viewState())")));
        await js("window.__rht.sceneObject().traverse((o) => { if (o.isDirectionalLight && o.castShadow) o.castShadow = true; })");
        await sleep(300);
        const a = await cap();
        await js("window.__rht.sceneObject().traverse((o) => { if (o.isDirectionalLight) { o.userData.hadShadow = o.castShadow; o.castShadow = false; } })");
        await sleep(500);
        const b = await cap();
        await js("window.__rht.sceneObject().traverse((o) => { if (o.isDirectionalLight && o.userData.hadShadow) o.castShadow = true; })");
        const bl = blobs(await raw(a), await raw(b), 16);
        // A shadow-map BORDER SMEAR is a huge, solidly-filled region; a real shadow is small.
        const huge = bl.filter((x) => x.n > 20000);
        const area = bl.reduce((t, x) => t + x.n, 0);
        console.log(map + " zoom " + zoom + ": shadow pixels " + (+(area / (1600 * 900) * 100).toFixed(2)) + "%, blobs " + bl.length +
          ", biggest " + (bl[0] ? bl[0].w + "x" + bl[0].h + " n=" + bl[0].n + " fill=" + bl[0].fill : "-") + ", regions>20k px: " + huge.length);
        const pair = await sharp({ create: { width: 1600, height: 900 * 2 + 8, channels: 3, background: "#101010" } })
          .composite([{ input: a, left: 0, top: 0 }, { input: b, left: 0, top: 908 }]).png().toBuffer();
        fs.writeFileSync(path.join(outDir, "shadowzoom-" + map + "-" + String(zoom).replace(".", "p") + ".png"), pair);
      }
      console.log("  shadowzoom-*.png written (top = shadows ON, bottom = key light castShadow OFF)");
    }

    if (probe === "wedge") {
      // What is the flat grey region at max zoom-out? Hide the big meshes ONE AT A TIME and watch
      // the colour of a probe pixel inside the region.
      const map = arg || "dustbowl";
      await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.62, pitch: 0.6, yaw: 0.2 })"); await sleep(400);
      await js("(() => { const c = document.querySelector('canvas'); for (let i = 0; i < 60; i += 1) c.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true, clientX: 800, clientY: 450 })); })()");
      await sleep(1600);
      console.log("view " + (await js("JSON.stringify(window.__rht.viewState())")));
      const list = JSON.parse(await js("(() => { const out = []; let i = 0; window.__rht.sceneObject().traverse((o) => { if (!o.isMesh || !o.visible) return; o.userData.__probeIdx = i; o.geometry.computeBoundingSphere(); const r = o.geometry.boundingSphere.radius * Math.max(o.scale.x, o.scale.y, o.scale.z); if (r > 20) out.push({ idx: i, r: +r.toFixed(1), geo: o.geometry.type, mat: o.material.type, color: o.material.color ? o.material.color.getHexString() : '', y: +o.position.y.toFixed(2), name: o.name || '', parent: (o.parent && (o.parent.name || o.parent.type)) || '' }); i += 1; }); return JSON.stringify(out); })()"));
      console.log("big meshes: " + JSON.stringify(list, null, 1));
      const a = await cap();
      fs.writeFileSync(path.join(outDir, "wedge-" + map + "-base.png"), a);
      const px = async (buf, x, y) => { const { data, ch } = await raw(buf); const i = (y * 1600 + x) * ch; return [data[i], data[i + 1], data[i + 2]]; };
      const PX = [[1500, 800], [1450, 720], [1560, 760]];
      for (const p0 of PX) console.log("probe pixel " + p0 + " base rgb " + (await px(a, p0[0], p0[1])));
      for (const m of list) {
        await js("window.__rht.sceneObject().traverse((o) => { if (o.userData && o.userData.__probeIdx === " + m.idx + ") o.visible = false; })");
        await sleep(350);
        const b = await cap();
        const bl = blobs(await raw(a), await raw(b), 16);
        const changed = bl.reduce((t, x) => t + x.n, 0);
        const cols = []; for (const p0 of PX) cols.push((await px(b, p0[0], p0[1])).join(","));
        console.log("hide idx " + m.idx + " (" + m.geo + " r=" + m.r + " col=" + m.color + " y=" + m.y + "): changed " + (+(changed / 14400).toFixed(2)) + "% | probe px -> " + cols.join(" | "));
        if (changed > 50000) fs.writeFileSync(path.join(outDir, "wedge-" + map + "-hide-" + m.idx + ".png"), b);
        await js("window.__rht.sceneObject().traverse((o) => { if (o.userData && o.userData.__probeIdx === " + m.idx + ") o.visible = true; })");
        await sleep(200);
      }
    }
  } catch (e) { console.error("probe failed:", e); process.exitCode = 1; }
  finally { server.close(); app.quit(); }
});
