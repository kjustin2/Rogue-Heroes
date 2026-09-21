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
// UI cases (all real-GPU, full FX): menu deploy settings armory campaign run tutorial pause victory defeat hover
// viewports = battle + deck + tech + mapselect + settings at 1280x720 / 1600x900 / 1920x1080 / 2560x1080

app.whenReady().then(async () => {
  const { server, port } = await serve();
  const win = new BrowserWindow({ width: 1600, height: 900, show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.showInactive();
  win.webContents.setAudioMuted(true);
  const js = (src) => win.webContents.executeJavaScript(src);
  const prefix = process.env.SHOT_PREFIX || "gpu-"; // SHOT_PREFIX=before- for a baseline build
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, "..", "shots", `${prefix}${name}.png`), img.toPNG()); console.log("shot: " + prefix + name + ".png"); };
  try {
    await win.loadURL(`http://127.0.0.1:${port}/`);
    for (let i = 0; i < 100 && !(await js("Boolean(window.__rht)")); i += 1) await sleep(100);
    await sleep(3000);
    for (const s of scenarios) {
      // Menu screens are reached the way the player reaches them: from the title, by button.
      const toTitle = async () => { await js(`(() => { if (window.__rht.toMenu) window.__rht.toMenu(); else { const b = document.querySelector("[data-back]"); if (b) b.click(); } })()`); await sleep(900); };
      const clickMenu = async (sel) => { await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); })()`); await sleep(900); };
      if (s === "menu") { await toTitle(); await shot("menu"); continue; }
      if (s === "mapselect") {
        // The Skirmish set-up page at the three widths that have bitten this repo: is every choice
        // (map, faction, mode, difficulty, Deploy) on screen, and is nothing under the CTA bar?
        for (const [w, h] of [[1280, 720], [1600, 900], [2560, 1080]]) {
          win.setSize(w, h); await sleep(500);
          await toTitle(); await clickMenu('[data-menu="play"]');
          await shot(`mapselect-${w}x${h}`);
          await js(`(() => { const c = document.querySelectorAll("[data-map]")[${Number(process.env.MAP_PICK || 2)}]; if (c) c.click(); })()`); await sleep(500);
          await shot(`mapselect-${w}x${h}-picked`);
        }
        win.setSize(1600, 900); await sleep(500);
        continue;
      }
      if (s === "viewports") {
        // Does the UI GROW into free space? Battle HUD, base command deck and the Skirmish page
        // at the four widths the owner plays at; the HUD must not be a strip in the middle at 2560.
        for (const [w, h] of [[1280, 720], [1600, 900], [1920, 1080], [2560, 1080]]) {
          win.setSize(w, h); await sleep(600);
          await js(`window.__rht.scenario("firefight"); window.__rht.deselect();`);
          await sleep(1500);
          await js(`(() => { const sim = window.__rht.sim; const u = sim.entities.find((e) => e.team === "player" && e.kind !== "base"); if (u) { sim.select(u.id); window.__rht.setIntent("shoot"); } })()`);
          await sleep(700);
          await shot(`vp-${w}x${h}-battle`);
          await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000); const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); if (base) sim.select(base.id); })()`);
          await sleep(500);
          await js(`(() => { const b = document.querySelector('[data-base-tab="deploy"]'); if (b) b.click(); })()`);
          await sleep(500);
          await shot(`vp-${w}x${h}-deck`);
          await js(`(() => { const b = document.querySelector('[data-base-tab="tech"]'); if (b) b.click(); })()`);
          await sleep(500);
          await shot(`vp-${w}x${h}-tech`);
          await toTitle(); await clickMenu('[data-menu="play"]');
          await shot(`vp-${w}x${h}-mapselect`);
          await toTitle(); await clickMenu('[data-menu="settings"]');
          await shot(`vp-${w}x${h}-settings`);
        }
        win.setSize(1600, 900); await sleep(500);
        continue;
      }
      if (s === "deploy") { await toTitle(); await clickMenu('[data-menu="play"]'); await shot("deploy"); continue; }
      if (s === "settings") { await toTitle(); await clickMenu('[data-menu="settings"]'); await shot("settings"); continue; }
      if (s === "armory") { await toTitle(); await clickMenu('[data-menu="armory"]'); await shot("armory"); continue; }
      if (s === "briefing") { await toTitle(); await clickMenu('[data-menu="campaign"]'); await clickMenu('[data-mission]'); await shot("briefing"); continue; }
      if (s === "campaign") { await toTitle(); await clickMenu('[data-menu="campaign"]'); await shot("campaign"); continue; }
      if (s === "run") { await toTitle(); await clickMenu('[data-menu="run"]'); await shot("run"); continue; }
      if (s === "pause") {
        // The in-battle pause card over a live firefight, then its Controls sub-page.
        await js(`window.__rht.scenario("firefight"); window.__rht.deselect();`);
        await sleep(1500);
        await clickMenu('[data-command="open-menu"]');
        await shot("pause");
        await clickMenu('[data-pause="controls"]');
        await shot("controls");
        await js(`document.querySelectorAll(".pause-overlay").forEach((e) => e.remove())`);
        continue;
      }
      if (s === "victory" || s === "defeat") {
        await js(`window.__rht.scenario(${JSON.stringify(s)}); window.__rht.deselect();`);
        await sleep(1800);
        await shot(s);
        continue;
      }
      if (s === "hover-deck") {
        // A deploy card's tooltip: it must hang ABOVE the command deck, never over its stats/tabs.
        await js(`window.__rht.scenario("firefight"); window.__rht.deselect();`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); if (base) sim.select(base.id); })()`);
        await sleep(700);
        await js(`(() => { const el = document.querySelectorAll("[data-spawn]")[1] || document.querySelector("[data-spawn]"); if (!el) return; const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()`);
        await sleep(400);
        await shot("hover-deck");
        continue;
      }
      if (s === "deployflow") {
        // Placed deploy end to end: base selected → Deploy tab → card click arms the ring with the
        // cursor ghost hovering a spot inside it (deployflow-ring) → the click fields the troop at
        // that spot (deployflow-placed). The ghost is the same intent the player's cursor drives.
        await js(`window.__rht.scenario("firefight"); window.__rht.deselect();`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 3000); const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); base.commandPoints = 1; sim.select(base.id); window.__rht.setView({ x: base.position.x, z: base.position.z + 2, zoom: 0.8, pitch: 0.62, yaw: 0.2 }); })()`);
        await sleep(700);
        await js(`(() => { const t = document.querySelector('[data-base-tab="deploy"]'); if (t) t.click(); })()`); await sleep(300);
        await js(`(() => { const c = document.querySelector('[data-spawn="soldier"]'); if (c) c.click(); })()`); await sleep(300);
        const armed = await js(`(() => { const sim = window.__rht.sim; const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); const point = { x: base.position.x + 3.2, z: base.position.z + 2.6 }; window.__rht.hoverGround(point); return JSON.stringify({ pending: sim.pendingDeploy, intent: sim.intent, ring: sim.deployPlacement(), ghost: sim.deployPointPreview(base, "soldier", point) }); })()`);
        console.log("deployflow armed:", armed);
        await sleep(600);
        await shot("deployflow-ring");
        const placed = await js(`(() => { const sim = window.__rht.sim; const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); const point = { x: base.position.x + 3.2, z: base.position.z + 2.6 }; const ok = window.__rht.queueDeployAt("soldier", point); window.__rht.hoverGround(undefined); const u = sim.entities.find((e) => e.id.startsWith("p-spawn-")); return JSON.stringify({ ok, point, at: u && u.position, pending: sim.pendingDeploy }); })()`);
        console.log("deployflow placed:", placed);
        await sleep(700);
        await shot("deployflow-placed");
        continue;
      }
      if (s === "hover") {
        // A tooltip open over the treasury bar: the one transient surface no static screen shows.
        await js(`window.__rht.scenario("firefight"); window.__rht.deselect();`);
        await sleep(1500);
        await js(`(() => { const el = document.querySelector(".money-bar"); const r = el.getBoundingClientRect(); const ev = new PointerEvent("pointerover", { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 }); el.dispatchEvent(ev); })()`);
        await sleep(400);
        await shot("hover");
        continue;
      }
      if (s === "tutorial") {
        // The first three beats a new player sees, straight from the title link.
        await toTitle();
        await js(`document.querySelector('[data-menu="tutorial"]').click()`);
        await sleep(3500);
        await shot("tutorial-1");
        await js(`(() => { const b = document.querySelector('[data-tut="next"]'); if (b) b.click(); })()`);
        await sleep(1500);
        await shot("tutorial-2");
        await js(`(() => { const b = document.querySelector('[data-tut="exit"]'); if (b) b.click(); })()`);
        await sleep(400);
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
      if (s === "rings") {
        // Range overlays on stepped terrain: a soldier at a mesa foot with the move field spanning the step,
        // then the HQ selected (its big ring crosses everything).
        await js(`window.__rht.scenario("high-ground"); window.__rht.deselect();`);
        await sleep(1800);
        await js(`(() => { const sim = window.__rht.sim; const covers = sim.entities.filter(e => e.kind === "cover" && e.coverKind === "ridge"); const r = covers[0]; const u = sim.debugSpawn("soldier", "player", { x: r ? r.position.x - r.radius - 0.8 : 0, z: r ? r.position.z : 0 }); sim.select(u.id); sim.setIntent("move"); window.__rht.setView({ x: u.position.x, z: u.position.z, zoom: 0.55, pitch: 0.6, yaw: 0.25 }); })()`);
        await sleep(900);
        await shot("rings-move");
        await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); if (hq) { sim.select(hq.id); window.__rht.setView({ x: hq.position.x, z: hq.position.z, zoom: 0.9, pitch: 0.6, yaw: 0.25 }); } })()`);
        await sleep(900);
        await shot("rings-base");
        // ...and the build-placement circle (Defenses tab → wall), which spans the mesa step.
        await js(`(() => { const sim = window.__rht.sim; sim.setIntent("build"); sim.setPendingBuild("wall"); })()`);
        await sleep(700);
        await shot("rings-build");
        await js(`(() => { const sim = window.__rht.sim; sim.setPendingBuild(undefined); sim.setIntent("select"); })()`);
        // A medic beside the ledge: its aura ring must follow the step like the move field does.
        await js(`(() => { const sim = window.__rht.sim; const r = sim.entities.filter(e => e.kind === "cover" && e.coverKind === "ridge")[0]; const m = sim.debugSpawn("medic", "player", { x: r ? r.position.x - r.radius - 1.2 : 2, z: r ? r.position.z + 1 : 2 }); window.__rht.deselect(); window.__rht.setView({ x: m.position.x, z: m.position.z, zoom: 0.5, pitch: 0.6, yaw: 0.25 }); })()`);
        await sleep(900);
        await shot("rings-aura");
        continue;
      }
      if (s === "baserings") {
        // The base selected on every map: its selection ring + placement circle must read on each palette.
        for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(2200);
          await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); window.__rht.setView({ x: hq.position.x, z: hq.position.z, zoom: 0.8, pitch: 0.6, yaw: 0.25 }); })()`);
          await sleep(700);
          await shot("basering-" + map);
          if (process.env.PROBE) console.log(map, await js(`(() => { const out = []; const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); const THREE_Box = null; window.__rht.sceneObject().traverse((o) => { if (!o.isMesh || !o.visible) return; o.geometry.computeBoundingSphere(); const bs = o.geometry.boundingSphere; const wp = o.getWorldPosition(o.position.clone()); const r = bs.radius * Math.max(o.scale.x, o.scale.y, o.scale.z) * (o.parent ? o.parent.scale.x : 1); if (r > 3.5 && r < 12 && Math.hypot(wp.x - hq.position.x, wp.z - hq.position.z) < 4) out.push([o.name, o.geometry.type, r.toFixed(1), wp.y.toFixed(2), o.material.type, o.material.color && o.material.color.getHexString(), o.material.opacity, o.material.transparent, o.parent && (o.parent.name || o.parent.userData.entityId || o.parent.type)]); }); return JSON.stringify(out); })()`));
        }
        continue;
      }
      if (s === "temporal") {
        // Consecutive real-GPU frames at FULL resolve speed during a volley: a shape that pops,
        // splotches or flickers frame to frame shows up as a difference between neighbours.
        const sharp = require("sharp");
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000);
          const line = [["soldier", -3], ["heavy", -1.8], ["sniper", -0.6], ["flamer", 0.6], ["mortar", 1.8], ["tank", 3.4], ["apc", 5.2]];
          const actors = line.map(([k, z]) => sim.debugSpawn(k, "player", { x: -4, z }));
          const targets = line.map(([, z], i) => sim.debugSpawn(i % 2 ? "soldier" : "heavy", "enemy", { x: (i % 2 ? 4 : 6), z }));
          for (const t of targets) { for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false; t.commandPoints = 0; t.maxCommandPoints = 0; }
          actors.forEach((a, i) => { sim.select(a.id); sim.setIntent("shoot"); sim.queueShoot(targets[i].id); });
          window.__rht.deselect(); window.__rht.setView({ x: 0.5, z: 1, zoom: 0.62, pitch: 0.55, yaw: 0.9 });
          window.__rht.setResolveScale(0.5); window.__rht.endTurn(); })()`);
        for (let i = 0; i < 60; i += 1) { if (await js(`window.__rht.sim.projectiles.length`)) break; await sleep(50); }
        await sleep(350);
        const frames = [];
        for (let i = 0; i < 12; i += 1) { await js(`window.__rht.setView({ x: 0.5, z: 1, zoom: 0.62, pitch: 0.55, yaw: 0.9 })`); frames.push((await win.webContents.capturePage({ x: 300, y: 150, width: 1000, height: 600 })).toPNG()); }
        const tiles = await Promise.all(frames.map((b) => sharp(b).resize(400, 240).png().toBuffer()));
        await sharp({ create: { width: 1600, height: 720, channels: 3, background: "#000" } })
          .composite(tiles.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 240 }))).png()
          .toFile(path.join(__dirname, "..", "shots", "gpu-temporal.png"));
        // Full-size pair for close inspection.
        fs.writeFileSync(path.join(__dirname, "..", "shots", "gpu-temporal-a.png"), frames[4]);
        fs.writeFileSync(path.join(__dirname, "..", "shots", "gpu-temporal-b.png"), frames[5]);
        console.log("shot: gpu-temporal.png (+ -a/-b full pair)");
        await js(`window.__rht.setResolveScale(1)`);
        await sleep(4000);
        continue;
      }
      if (s === "boot") {
        // The first six seconds after launch, then the campaign mission intro flyover: 12 frames each
        // at 400ms so a flashing/flickering sequence is visible as a strip.
        const strip = async (name, frames, gap) => {
          const sharp = require("sharp");
          const tiles = [];
          for (let i = 0; i < frames; i += 1) { tiles.push((await win.webContents.capturePage()).toPNG()); await sleep(gap); }
          const small = await Promise.all(tiles.map((b) => sharp(b).resize(400, 225).png().toBuffer()));
          await sharp({ create: { width: 1600, height: 225 * Math.ceil(frames / 4), channels: 3, background: "#000" } })
            .composite(small.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 225 }))).png()
            .toFile(path.join(__dirname, "..", "shots", `gpu-${name}.png`));
          console.log("shot: gpu-" + name + ".png");
        };
        await win.webContents.reload();
        await sleep(300);
        await strip("boot-title", 12, 400);
        await js(`(() => { const b = document.querySelector('[data-menu="campaign"]'); if (b) b.click(); })()`);
        await sleep(1200);
        await js(`(() => { const m = document.querySelector('[data-mission]'); if (m) m.click(); })()`);
        await sleep(800);
        await js(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /deploy to battle/i.test(x.textContent || "")); if (b) b.click(); })()`);
        await sleep(200);
        if (process.env.PROBE) { const views = []; for (let i = 0; i < 60; i += 1) { views.push(await js(`(() => { const v = window.__rht.viewState ? window.__rht.viewState() : null; return v ? [v.x.toFixed(2), v.z.toFixed(2), v.zoom.toFixed(3), v.yaw.toFixed(3), v.pitch.toFixed(3)].join(",") : "?"; })()`)); await sleep(30); } console.log("views:", views.join(" | ")); }
        await strip("boot-mission", 20, 300);
        continue;
      }
      if (s === "recon") {
        // Recon pulse ghost arrows + a deployed artillery piece on its outriggers.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000);
          const a = sim.debugSpawn("artillery", "player", { x: -6, z: 2 }); a.deployed = true; a.yaw = 0.3;
          sim.debugSpawn("droneop", "player", { x: -3, z: -2 });
          sim.debugSpawn("soldier", "enemy", { x: 6, z: 1 }); sim.debugSpawn("heavy", "enemy", { x: 7, z: -3 });
          sim.revealedOrders = true; window.__rht.deselect();
          window.__rht.setView({ x: 0, z: 0, zoom: 0.55, pitch: 0.55, yaw: 0.3 }); })()`);
        await sleep(1500);
        await shot("recon");
        continue;
      }
      if (s === "direction") {
        // One art direction: a tank, an APC and two troopers in one close frame.
        await js(`window.__rht.startBattle("verdant", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; const t = sim.debugSpawn("tank", "player", { x: -2, z: 0 }); t.yaw = 0.6; const a = sim.debugSpawn("apc", "enemy", { x: 3.5, z: -2 }); a.yaw = 2.4; const s1 = sim.debugSpawn("soldier", "player", { x: 0.6, z: 1.6 }); s1.yaw = 0.4; const s2 = sim.debugSpawn("heavy", "player", { x: 1.8, z: 2.4 }); s2.yaw = 0.2; window.__rht.deselect(); window.__rht.setView({ x: 0.5, z: 0.5, zoom: 0.36, pitch: 0.5, yaw: 0.35 }); })()`);
        await sleep(2500);
        await shot("direction");
        continue;
      }
      if (s === "nowalk") {
        // Impassable reads: a cliff face and a water channel with its bridge, close.
        await js(`window.__rht.startBattle("causeway", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; const w = sim.mapDef.terrain.water?.[0]; const b = sim.mapDef.terrain.bridges?.[0]; const cx = b ? (b.minX + b.maxX) / 2 : (w ? (w.minX + w.maxX) / 2 : 0); const cz = w ? (w.minZ + w.maxZ) / 2 : 0; window.__rht.deselect(); window.__rht.setView({ x: cx, z: cz, zoom: 0.5, pitch: 0.55, yaw: 0.4 }); })()`);
        await sleep(1200);
        await shot("nowalk-water");
        if (process.env.PROBE) console.log("water probe:", await js(`(() => { const out = []; window.__rht.sceneObject().traverse((o) => { if (o.isMesh && o.material && o.material.map && o.material.map.image && o.material.map.image.width === 256 && o.geometry.type === "BoxGeometry") out.push({ y: o.position.y.toFixed(2), w: o.geometry.parameters.width.toFixed(1), map: !!o.material.map, uv: !!o.geometry.getAttribute("uv"), op: o.material.opacity, color: o.material.color.getHexString() }); }); return JSON.stringify(out); })()`));
        if (process.env.PROBE) { const data = await js(`(() => { let c; window.__rht.sceneObject().traverse((o) => { if (!c && o.isMesh && o.material && o.material.map && o.geometry.type === "BoxGeometry" && o.material.map.image && o.material.map.image.width === 256) c = o.material.map.image; }); return c ? c.toDataURL() : ""; })()`); if (data) fs.writeFileSync(path.join(__dirname, "..", "shots", "probe-waves.png"), Buffer.from(data.split(",")[1], "base64")); }
        if (process.env.PROBE) { await js(`window.__rht.sceneObject().traverse((o) => { if (o.isMesh && o.material && o.material.map && o.geometry.type === "BoxGeometry" && o.material.map.image && o.material.map.image.width === 256) { o.material.color.set(0xff0000); o.material.opacity = 1; } })`); await sleep(400); await shot("probe-water-red"); }
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; const b = sim.mapDef.terrain.blocks.filter(x => x.height > 1.5)[0]; window.__rht.deselect(); window.__rht.setView({ x: b.minX - 1, z: (b.minZ + b.maxZ) / 2, zoom: 0.5, pitch: 0.5, yaw: 0.6 }); })()`);
        await sleep(1200);
        await shot("nowalk-cliff");
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
      if (s === "maps") {
        // One gameplay-zoom frame per battlefield, for the prop-variety / palette review.
        for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal"); window.__rht.deselect();`);
          await sleep(3000);
          await js(`window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.6, yaw: 0.2 })`);
          await sleep(900);
          await shot("map-" + map);
        }
        continue;
      }
      if (s === "overview") {
        // The whole battlefield from high up, plus one close frame per named section: does the map
        // read as a PLACE with sections and a landmark at a glance, not a sprinkle of props?
        const views = {
          dustbowl: [["river", -18, 0, 0.55], ["plateau", -18, 12, 0.55], ["canyon", -10, 24, 0.55]],
          ironworks: [["foundry", -18, 10, 0.55], ["railyard", -14, -11, 0.55], ["overpass", 0, 0, 0.55]],
          verdant: [["orchard", -21, -14, 0.55], ["chapel", -22, 12, 0.55], ["millpond", -12, 12, 0.55]],
          causeway: [["harbour", -34, 16, 0.55], ["village", -34, -16, 0.55], ["causeway", -8, 0, 0.55]],
          karak: [["precinct", -3, 8, 0.55], ["amphitheatre", -20, -16, 0.55], ["cistern", -19, 2, 0.55]],
          crossfire: [["checkpoint", -8, 0, 0.55], ["radar", -23, 11, 0.55], ["trench", -8, -11, 0.55]],
        };
        for (const map of Object.keys(views)) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal"); window.__rht.deselect();`);
          await sleep(3000);
          await js(`window.__rht.setView({ x: 0, z: 0, zoom: 3.4, pitch: 1.2, yaw: 3.73, overview: true })`);
          await sleep(900);
          await shot("map-" + map + "-wide");
          for (const [name, x, z, zoom] of views[map]) {
            await js(`window.__rht.setView({ x: ${x}, z: ${z}, zoom: ${zoom}, pitch: 0.7, yaw: 0.35 })`);
            await sleep(700);
            await shot("map-" + map + "-" + name);
          }
        }
        continue;
      }
      if (s === "volley") {
        // Every projectile family in flight on the real GPU: a firing line (rifle, MG, marksman,
        // flamer, mortar, tank, APC) resolves at a crawl and is shot three times through the volley
        // (flight, impacts, smoke). Toon rounds + ink rims are opaque flat colour, which the headless
        // SwiftShader strips already prove; this is the composer/bloom/tone-mapped truth.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000);
          const line = [["soldier", -3], ["heavy", -1.8], ["sniper", -0.6], ["flamer", 0.6], ["mortar", 1.8], ["tank", 3.4], ["apc", 5.2]];
          const actors = line.map(([k, z]) => sim.debugSpawn(k, "player", { x: -4, z }));
          const targets = line.map(([, z], i) => sim.debugSpawn(i % 2 ? "soldier" : "heavy", "enemy", { x: (i === 3 ? 1.5 : i >= 4 ? 5 : 3.5), z }));
          for (const t of targets) { for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false; }
          actors.forEach((a, i) => { sim.select(a.id); sim.setIntent("shoot"); sim.queueShoot(targets[i].id); });
          window.__rht.deselect(); window.__rht.setView({ x: 0.5, z: 1, zoom: 0.62, pitch: 0.55, yaw: 0.9 });
          window.__rht.setResolveScale(0.2); window.__rht.endTurn(); })()`);
        // Wait for the first rounds to leave their barrels, then let the volley spread out.
        for (let i = 0; i < 60; i += 1) { if (await js(`window.__rht.sim.projectiles.length`)) break; await sleep(250); }
        await sleep(1800);
        await js(`window.__rht.setView({ x: 0.5, z: 1, zoom: 0.62, pitch: 0.55, yaw: 0.9 })`);
        await sleep(200);
        await shot("volley-flight");
        await sleep(2600);
        await js(`window.__rht.setView({ x: 0.5, z: 1, zoom: 0.62, pitch: 0.55, yaw: 0.9 })`);
        await sleep(200);
        await shot("volley-impact");
        await sleep(3500);
        await js(`window.__rht.setView({ x: 0.5, z: 1, zoom: 0.62, pitch: 0.55, yaw: 0.9 })`);
        await sleep(200);
        await shot("volley-late");
        await js(`window.__rht.setResolveScale(1)`);
        await sleep(4000);
        continue;
      }
      if (s === "vehicles" || s === "structures") {
        // Review frames for the Blender vehicles kit (art/vehicles): same ramp and ink as the
        // troopers, team read via accent, nothing floating or sunk. `vehicles` = tank / APC /
        // artillery for both teams with a trooper for scale (plus a close pass); `structures` =
        // gun turret / mortar battery / HQ for both teams, and the crate / sandbag / barricade cover.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        if (s === "vehicles") {
          await js(`(() => { const sim = window.__rht.sim;
            ["tank","apc","artillery"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -6 + i * 6, z: 2.5 }); u.yaw = 0.5; });
            ["tank","apc","artillery"].forEach((k, i) => { const u = sim.debugSpawn(k, "enemy", { x: -6 + i * 6, z: -4 }); u.yaw = 2.6; });
            const s1 = sim.debugSpawn("soldier", "player", { x: 9.5, z: 2.5 }); s1.yaw = 0.5;
            const s2 = sim.debugSpawn("heavy", "player", { x: -9.5, z: 2.5 }); s2.yaw = 0.5;
            window.__rht.deselect(); })()`);
          await sleep(2500);
          await js(`window.__rht.setView({ x: 0, z: -0.5, zoom: 0.5, pitch: 0.5, yaw: 0.35 })`);
          await sleep(600);
          await shot("vehicles");
          await js(`window.__rht.setView({ x: -3, z: 2.5, zoom: 0.3, pitch: 0.42, yaw: 0.7 })`);
          await sleep(600);
          await shot("vehicles-close");
        } else {
          await js(`(() => { const sim = window.__rht.sim;
            const t = sim.debugStructure("turret", "player", { x: -7, z: 2.5 }); t.yaw = 0.5;
            const x = sim.debugStructure("exturret", "player", { x: -3, z: 2.5 }); x.yaw = 0.5;
            const b = sim.debugStructure("base", "player", { x: 3, z: 2.5 }); b.yaw = 0.5;
            const t2 = sim.debugStructure("turret", "enemy", { x: -7, z: -4 }); t2.yaw = 2.6;
            const b2 = sim.debugStructure("base", "enemy", { x: 3, z: -4 }); b2.yaw = 2.6;
            sim.debugCover("crate", { x: 8, z: 3.5 }); sim.debugCover("sandbag", { x: 8.5, z: 0.5 }); sim.debugCover("barricade", { x: 8, z: -2.5 });
            const s1 = sim.debugSpawn("soldier", "player", { x: 10.5, z: 1 }); s1.yaw = 0.5;
            window.__rht.deselect(); })()`);
          await sleep(2500);
          await js(`window.__rht.setView({ x: 1, z: -0.5, zoom: 0.5, pitch: 0.5, yaw: 0.35 })`);
          await sleep(600);
          await shot("structures");
          await js(`window.__rht.setView({ x: 7.5, z: 0.5, zoom: 0.28, pitch: 0.45, yaw: 0.6 })`);
          await sleep(600);
          await shot("structures-close");
          await js(`window.__rht.setView({ x: -5, z: 2.5, zoom: 0.3, pitch: 0.45, yaw: 0.6 })`);
          await sleep(600);
          await shot("structures-turret");
        }
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
