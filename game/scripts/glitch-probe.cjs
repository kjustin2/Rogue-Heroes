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

    if (probe === "whitebars") {
      // Long thin NEAR-WHITE meshes float through logs and tree trunks on verdant. Enumerate every
      // visible mesh whose material colour is near-white and report its world size + owner.
      const map = arg || "verdant";
      await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 })"); await sleep(1200);
      const out = await js("(() => { const acc = {}; const rows = []; window.__rht.sceneObject().traverse((o) => {" +
        " if (!o.isMesh || !o.visible || !o.material || !o.material.color) return;" +
        " const c = o.material.color; const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;" +
        " if (lum < 0.72) return;" +
        " o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox; const sz = bb.max.clone().sub(bb.min).multiply(o.scale);" +
        " const wp = o.getWorldPosition(o.position.clone());" +
        " const key = (o.parent && (o.parent.name || o.parent.userData.entityId || o.parent.type)) + '|' + o.geometry.type + '|' + c.getHexString() + '|' + o.material.type + '|' + (o.userData.part || '');" +
        " acc[key] = (acc[key] || 0) + 1;" +
        " if (rows.length < 14) rows.push({ key, size: [+sz.x.toFixed(2), +sz.y.toFixed(2), +sz.z.toFixed(2)], at: [+wp.x.toFixed(1), +wp.y.toFixed(2), +wp.z.toFixed(1)], inst: o.isInstancedMesh ? o.count : 1, ud: JSON.stringify(o.userData).slice(0, 120) });" +
        " }); return JSON.stringify({ acc, rows }); })()");
      const parsed = JSON.parse(out);
      console.log("near-white mesh groups (count by parent|geo|color|mat|part):");
      for (const [k, v] of Object.entries(parsed.acc).sort((a, b) => b[1] - a[1])) console.log("  " + v + " x " + k);
      console.log("samples:"); for (const r of parsed.rows) console.log("  " + JSON.stringify(r));
    }

    if (probe === "decor") {
      // interactionGlow() hangs a 4-bar unlit bracket on every cover prop. Count them, and capture
      // the bisection pair (all userData.decor meshes hidden) on every map.
      for (const map of (arg ? [arg] : ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"])) {
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3500);
        await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 })"); await sleep(1200);
        const stats = await js("(() => { let bars = 0, onScreen = 0, floating = 0; const cam = window.__rht.cameraObject();" +
          " window.__rht.sceneObject().traverse((o) => { if (!o.isMesh || !o.userData || !o.userData.decor || o.geometry.type !== 'BoxGeometry') return; bars += 1;" +
          " const wp = o.getWorldPosition(o.position.clone()); if (wp.y > 0.9) floating += 1;" +
          " const pr = wp.clone().project(cam); if (Math.abs(pr.x) < 1 && Math.abs(pr.y) < 1 && pr.z < 1) onScreen += 1; });" +
          " return JSON.stringify({ bars, brackets: bars / 4, onScreen, floatingAbove0m9: floating }); })()");
        const a = await cap();
        await js("window.__rht.sceneObject().traverse((o) => { if (o.isMesh && o.userData && o.userData.decor && o.geometry.type === 'BoxGeometry') o.visible = false; })");
        await sleep(400);
        const b = await cap();
        const bl = blobs(await raw(a), await raw(b), 16);
        console.log(map + " " + stats + " -> vanished blobs " + bl.length + ", changed px " + (+(bl.reduce((t, x) => t + x.n, 0) / 14400).toFixed(2)) + "%");
        await sharp({ create: { width: 1600, height: 1808, channels: 3, background: "#101010" } })
          .composite([{ input: a, left: 0, top: 0 }, { input: b, left: 0, top: 908 }]).png()
          .toFile(path.join(outDir, "decor-" + map + ".png"));
      }
      console.log("  decor-<map>.png written (top = shipped, bottom = brackets hidden)");
    }

    if (probe === "shimmerbisect") {
      // Which layer owns the frame-to-frame change in a STATIC command phase? Toggle one layer at
      // a time and re-measure the median neighbouring-pair changed-pixel count over 8 frames.
      const pairPct = async (frames) => {
        const raws = []; for (const f of frames) raws.push(await raw(f));
        const vals = []; for (let i = 0; i + 1 < raws.length; i += 1) { const d = blobs(raws[i], raws[i + 1], 14); vals.push(d.reduce((t, x) => t + x.n, 0)); }
        vals.sort((a, b) => a - b);
        return +(vals[Math.floor(vals.length / 2)] / 14400).toFixed(3);
      };
      const burst = async (n) => { const f = []; for (let i = 0; i < n; i += 1) f.push(await cap()); return f; };
      const layers = [
        ["baseline (everything on)", "1"],
        ["ambient PointsMaterial bed OFF", "window.__rht.sceneObject().traverse((o) => { if (o.isPoints && o.material.type === 'PointsMaterial') o.visible = false; })"],
        ["cover interactionGlow brackets OFF", "window.__rht.sceneObject().traverse((o) => { if (o.isMesh && o.userData && o.userData.decor && o.geometry.type === 'BoxGeometry') o.visible = false; })"],
        ["ground-detail InstancedMesh OFF", "window.__rht.sceneObject().traverse((o) => { if (o.isInstancedMesh) o.visible = false; })"],
        ["key-light shadows OFF", "window.__rht.sceneObject().traverse((o) => { if (o.isDirectionalLight) o.castShadow = false; })"],
      ];
      for (const map of (arg ? [arg] : ["verdant", "crossfire", "dustbowl"])) {
        console.log(map + ":");
        for (const [label, code] of layers) {
          await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
          await sleep(3500);
          await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 })");
          await sleep(1500);
          await js(code); await sleep(600);
          await js("window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 })"); await sleep(300);
          console.log("  " + (await pairPct(await burst(8))) + "%  <- " + label);
        }
      }
    }

    if (probe === "canopy") {
      // A regular dashed hatching band sits on tree-canopy facets. Ledger rule: turn the key
      // light's castShadow OFF FIRST. If it survives, it is not a shadow.
      await js("window.__rht.startBattle(\"verdant\", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      const at = await js("(() => { const s = window.__rht.sim; const t = s.entities.filter(e => e.kind === 'cover' && e.coverKind === 'tree')[0]; return t ? JSON.stringify({ x: t.position.x, z: t.position.z }) : ''; })()");
      if (!at) { console.log("no tree"); } else {
        const t = JSON.parse(at);
        await js("window.__rht.setView({ x: " + t.x + ", z: " + (t.z + 1.5) + ", zoom: 0.62, pitch: 0.45, yaw: 0.3 })");
        await sleep(1500);
        const a = await cap(); fs.writeFileSync(path.join(outDir, "canopy-shadow-on.png"), a);
        await js("window.__rht.sceneObject().traverse((o) => { if (o.isDirectionalLight) o.castShadow = false; })");
        await sleep(700);
        const b = await cap(); fs.writeFileSync(path.join(outDir, "canopy-shadow-off.png"), b);
        const bl = blobs(await raw(a), await raw(b), 10);
        console.log("canopy: shadows on-vs-off changed " + (+(bl.reduce((x, y) => x + y.n, 0) / 14400).toFixed(2)) + "%, blobs " + bl.length);
        const reg = { left: 560, top: 250, width: 480, height: 400 };
        const ca = await sharp(a).extract(reg).resize(960, 800, { kernel: "nearest" }).png().toBuffer();
        const cb = await sharp(b).extract(reg).resize(960, 800, { kernel: "nearest" }).png().toBuffer();
        await sharp({ create: { width: 1930, height: 800, channels: 3, background: "#101010" } })
          .composite([{ input: ca, left: 0, top: 0 }, { input: cb, left: 970, top: 0 }]).png()
          .toFile(path.join(outDir, "canopy-bisect.png"));
        console.log("  canopy-bisect.png (left = shadows ON, right = OFF)");
      }
    }

    if (probe === "canopyz") {
      // The canopy hatch survived the shadow bisection, so it is a MAIN-PASS artefact. Two tests:
      // (1) widen the camera near plane (more depth precision) -- a z-fight changes or clears;
      // (2) micro-dolly the camera -- a z-fight SWIMS frame to frame, a texture does not.
      await js("window.__rht.startBattle(\"verdant\", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      const at = JSON.parse(await js("(() => { const s = window.__rht.sim; const t = s.entities.filter(e => e.kind === 'cover' && e.coverKind === 'tree')[0]; return JSON.stringify({ x: t.position.x, z: t.position.z }); })()"));
      const view = (dx) => "window.__rht.setView({ x: " + (at.x + dx) + ", z: " + (at.z + 1.5) + ", zoom: 0.62, pitch: 0.45, yaw: 0.3 })";
      await js(view(0)); await sleep(1500);
      const reg = { left: 600, top: 240, width: 340, height: 260 };
      const crop = async (b, z) => sharp(b).extract(reg).resize(340 * z, 260 * z, { kernel: "nearest" }).png().toBuffer();
      console.log("near plane sweep:");
      const nears = [];
      for (const n of [1, 4, 12]) {
        await js("(() => { const c = window.__rht.cameraObject(); c.near = " + n + "; c.updateProjectionMatrix(); })()");
        await sleep(600); const b = await cap(); nears.push(await crop(b, 3));
        console.log("  near=" + n + " captured");
      }
      await sharp({ create: { width: 340 * 3 * 3 + 20, height: 260 * 3, channels: 3, background: "#101010" } })
        .composite(nears.map((input, i) => ({ input, left: i * (340 * 3 + 10), top: 0 }))).png()
        .toFile(path.join(outDir, "canopyz-nearplane.png"));
      await js("(() => { const c = window.__rht.cameraObject(); c.near = 1; c.updateProjectionMatrix(); })()");
      await sleep(500);
      console.log("micro-dolly (0.02 world units per frame):");
      const frames = [];
      for (let i = 0; i < 6; i += 1) { await js(view(i * 0.02)); await sleep(200); frames.push(await cap()); }
      const tiles = []; for (const f of frames) tiles.push(await crop(f, 3));
      await sharp({ create: { width: (340 * 3 + 10) * 3, height: (260 * 3 + 10) * 2, channels: 3, background: "#101010" } })
        .composite(tiles.map((input, i) => ({ input, left: (i % 3) * (340 * 3 + 10), top: Math.floor(i / 3) * (260 * 3 + 10) }))).png()
        .toFile(path.join(outDir, "canopyz-dolly.png"));
      const ra = await raw(frames[0]), rb = await raw(frames[1]);
      const bl = blobs(ra, rb, 14);
      console.log("  canopyz-nearplane.png (near 1 | 4 | 12), canopyz-dolly.png (6 frames, 2cm apart)");
    }

    if (probe === "flatoverlay") {
      // Ground overlays in the pickups/mines/zones block are FLAT discs at the sim height, unlike
      // the move field / weapon ring which are draped (drapeToTerrain). Count how many sit where a
      // flat disc cannot lie: within its own radius of a terrain-block edge (a real step).
      for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
        await js("window.__rht.startBattle(" + JSON.stringify(map) + ", \"destroy\", \"normal\"); window.__rht.deselect();");
        await sleep(3000);
        console.log(map + " " + await js("(() => { const s = window.__rht.sim; const blocks = s.mapDef.terrain.blocks || [];" +
          " const nearEdge = (x, z, r) => blocks.some((b) => { const inX = x > b.minX - r && x < b.maxX + r; const inZ = z > b.minZ - r && z < b.maxZ + r;" +
          "   const deepX = x > b.minX + r && x < b.maxX - r; const deepZ = z > b.minZ + r && z < b.maxZ - r; return inX && inZ && !(deepX && deepZ); });" +
          " const picks = (s.pickups || []); const mines = (s.mines || []); const zones = (s.environment ? s.environment().zones : []) || [];" +
          " return JSON.stringify({ pickups: picks.length, pickupsStraddlingAStep: picks.filter((p) => nearEdge(p.x, p.z, 0.74)).length," +
          "   mines: mines.length, minesStraddling: mines.filter((m) => nearEdge(m.x, m.z, 0.26)).length," +
          "   zones: zones.length, zonesStraddling: zones.filter((z) => nearEdge(z.x, z.z, z.radius)).length }); })()"));
      }
    }

    if (probe === "canopynormal") {
      // Last suspect for the canopy hatch: the per-part detail NORMAL MAP minified on a facet.
      await js("window.__rht.startBattle(\"verdant\", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3500);
      const t = JSON.parse(await js("(() => { const s = window.__rht.sim; const x = s.entities.filter(e => e.kind === 'cover' && e.coverKind === 'tree')[0]; return JSON.stringify({ x: x.position.x, z: x.position.z }); })()"));
      await js("window.__rht.setView({ x: " + t.x + ", z: " + (t.z + 1.5) + ", zoom: 0.62, pitch: 0.45, yaw: 0.3 })");
      await sleep(1500);
      const reg = { left: 600, top: 240, width: 340, height: 260 };
      const crop = async (b) => sharp(b).extract(reg).resize(1020, 780, { kernel: "nearest" }).png().toBuffer();
      const a = await cap();
      const n = await js("(() => { let hit = 0; const seen = new Set(); window.__rht.sceneObject().traverse((o) => { if (!o.isMesh || !o.material) return; const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (m.normalMap && !seen.has(m.uuid)) { seen.add(m.uuid); m.userData.__nm = m.normalMap; m.normalMap = null; m.needsUpdate = true; hit += 1; } } }); return hit; })()");
      await sleep(900);
      const b = await cap();
      console.log("nulled normalMap on " + n + " materials");
      const bl = blobs(await raw(a), await raw(b), 10);
      console.log("  changed " + (+(bl.reduce((x, y) => x + y.n, 0) / 14400).toFixed(2)) + "%");
      await sharp({ create: { width: 2050, height: 780, channels: 3, background: "#101010" } })
        .composite([{ input: await crop(a), left: 0, top: 0 }, { input: await crop(b), left: 1030, top: 0 }]).png()
        .toFile(path.join(outDir, "canopy-normalmap.png"));
      console.log("  canopy-normalmap.png (left = shipped, right = normalMap nulled)");
    }

    if (probe === "gait") {
      // LEG SEAMS, deterministically. __rht.silhouette(true) draws every unit as flat BLACK on
      // WHITE and hides everything that is not a unit, so a gap between thigh / shin / boot is a
      // WHITE island fully enclosed by black. Any white connected component that does not touch
      // the image border is a HOLE in a trooper -- a seam, measured, not judged by eye.
      await js("window.__rht.startBattle(\"dustbowl\", \"destroy\", \"normal\"); window.__rht.deselect();");
      await sleep(3000);
      const u = JSON.parse(await js("(() => { const s = window.__rht.sim; s.economy.set('player', 9000);" +
        " const a = s.debugSpawn('soldier', 'player', { x: -6, z: 0 }); a.yaw = 0.4;" +
        " return JSON.stringify({ id: a.id, x: a.position.x, z: a.position.z }); })()"));
      await sleep(1200);
      await js("window.__rht.silhouette(true)"); await sleep(600);
      await js("window.__rht.setView({ x: " + (u.x + 2) + ", z: " + (u.z + 0.6) + ", zoom: 0.18, pitch: 0.28, yaw: 0.9 })");
      await sleep(900);
      await js("(() => { const s = window.__rht.sim; s.select('" + u.id + "'); s.setIntent('move'); s.queueMove({ x: " + (u.x + 7) + ", z: " + u.z + " }); window.__rht.deselect(); window.__rht.setResolveScale(0.25); window.__rht.endTurn(); })()");
      await sleep(600);
      const frames = [];
      for (let i = 0; i < 16; i += 1) { await js("window.__rht.setView({ x: " + (u.x + 2) + ", z: " + (u.z + 0.6) + ", zoom: 0.18, pitch: 0.28, yaw: 0.9 })"); frames.push(await cap()); await sleep(110); }
      await js("window.__rht.setResolveScale(1); window.__rht.silhouette(false);");
      let worst = { holes: 0, area: 0, idx: 0 };
      for (let i = 0; i < frames.length; i += 1) {
        const { data, w, h, ch } = await raw(frames[i]);
        // white mask = background; flood from the border; anything white left over is a HOLE.
        const white = new Uint8Array(w * h);
        for (let k = 0, p2 = 0; k < w * h; k += 1, p2 += ch) white[k] = (data[p2] > 200 && data[p2 + 1] > 200 && data[p2 + 2] > 200) ? 1 : 0;
        const seen = new Uint8Array(w * h); const st = [];
        for (let x = 0; x < w; x += 1) { for (const y of [0, h - 1]) { const k = y * w + x; if (white[k] && !seen[k]) { seen[k] = 1; st.push(k); } } }
        for (let y = 0; y < h; y += 1) { for (const x of [0, w - 1]) { const k = y * w + x; if (white[k] && !seen[k]) { seen[k] = 1; st.push(k); } } }
        while (st.length) { const j = st.pop(); const x = j % w, y = (j / w) | 0;
          for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (k >= 0 && white[k] && !seen[k]) { seen[k] = 1; st.push(k); } }
        let holes = 0, area = 0;
        const hseen = new Uint8Array(w * h);
        for (let k = 0; k < w * h; k += 1) {
          if (!white[k] || seen[k] || hseen[k]) continue;
          let n = 0; st.length = 0; st.push(k); hseen[k] = 1;
          while (st.length) { const j = st.pop(); n += 1; const x = j % w, y = (j / w) | 0;
            for (const k2 of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (k2 >= 0 && white[k2] && !seen[k2] && !hseen[k2]) { hseen[k2] = 1; st.push(k2); } }
          if (n >= 6) { holes += 1; area += n; }
        }
        console.log("  frame " + i + ": enclosed white holes " + holes + ", total hole area " + area + " px");
        if (area > worst.area) worst = { holes, area, idx: i };
      }
      console.log("worst frame " + worst.idx + ": " + worst.holes + " holes / " + worst.area + " px");
      fs.writeFileSync(path.join(outDir, "gait-worst.png"), frames[worst.idx]);
      const tiles = []; for (const f of frames.slice(0, 8)) tiles.push(await sharp(f).extract({ left: 560, top: 180, width: 480, height: 560 }).resize(480, 560).png().toBuffer());
      await sharp({ create: { width: 480 * 4, height: 560 * 2, channels: 3, background: "#888" } })
        .composite(tiles.map((input, i) => ({ input, left: (i % 4) * 480, top: Math.floor(i / 4) * 560 }))).png()
        .toFile(path.join(outDir, "gait-silhouette-strip.png"));
      console.log("  gait-silhouette-strip.png, gait-worst.png");
    }
  } catch (e) { console.error("probe failed:", e); process.exitCode = 1; }
  finally { server.close(); app.quit(); }
});
