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
// UI cases (all real-GPU, full FX): menu deploy settings armory achievements tutorial pause victory defeat hover
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
      // The set-up is a step flow whose tabs open only steps already reached: walk Next to step n.
      const toStep = async (n) => { await js(`(() => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < ${n}; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector('[data-step-jump="${n}"]').click(); })()`); await sleep(900); };
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
      if (s === "sides") {
        // Set-up step 2: the faction cards (no doctrine names), at 1280x720 and 1600x900.
        for (const [w, h] of [[1280, 720], [1600, 900]]) {
          win.setSize(w, h); await sleep(500);
          await toTitle(); await clickMenu('[data-menu="play"]');
          await toStep(2);
          await shot(`sides-${w}x${h}`);
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
      if (s === "setupflow") {
        // The three set-up steps (Battlefield / Sides / Rules) at 1280x720, the width that bites.
        win.setSize(1280, 720); await sleep(500);
        await toTitle(); await clickMenu('[data-menu="play"]');
        for (const n of [1, 2, 3]) { await toStep(n); await shot(`setup-step${n}`); }
        await toTitle(); await clickMenu('[data-menu="settings"]'); await shot("settings-display");
        await clickMenu('[data-settings-tab="gameplay"]'); await shot("settings-gameplay");
        win.setSize(1600, 900); await sleep(500);
        continue;
      }
      if (s === "thrown") {
        // A pushed trooper FLIES (arc + backward tumble + landing dust) instead of teleporting.
        // Resolve slowed to a quarter so the flight spans several captures.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2400);
        await js(`(() => { const r = window.__rht, s = r.sim; s.economy.set("enemy", 0); const p = s.debugSpawn("heavy", "player", { x: -6, z: 0 }); const v = s.debugSpawn("soldier", "enemy", { x: -4.6, z: 0 }); for (const q of v.parts) if (q.role === "mobility" || q.role === "weapon") q.hp = 0; s.debugSelect(p.id); s.queueShove(v.id); r.setView({ x: -2, z: 0, zoom: 0.3, pitch: 0.35, yaw: Math.PI / 2 }); r.setResolveScale(0.25); r.endTurn(); })()`);
        for (let i = 0; i < 8; i += 1) { await sleep(260); await shot(`thrown-${i}`); }
        await js(`window.__rht.setResolveScale(1)`);
        continue;
      }
      if (s === "factionmeasure") {
        // Capture for scripts/measure-factions.mjs (analysis there): every subject alone, per
        // faction, identical framing, colour shot then silhouette shot. Real GPU, full FX.
        const dir = path.join(__dirname, "..", "shots", "factions-measure");
        fs.mkdirSync(dir, { recursive: true });
        win.setSize(900, 700); await sleep(500);
        await js(`(() => { const s = document.createElement("style"); s.textContent = "#ui, .toast, .mission-intro, .battle-loading { visibility: hidden !important; }"; document.head.appendChild(s); })()`);
        const SUBJ = [["base", "base", 0.62], ["rifleman", "soldier", 0.3], ["heavy", "heavy", 0.3], ["marksman", "sniper", 0.3],
          ["tank", "tank", 0.5], ["flak", "flak", 0.5], ["turret", "turret", 0.45]];
        // Every unit each faction fields, colour only, for the membership check (does a signature
        // unit read as its faction?). Flyers are framed from higher up.
        const ROSTERS = { vanguard: ["soldier", "skater", "sniper", "jumper", "heavy", "breaker", "tank", "flak", "gunship"],
          syndicate: ["soldier", "sniper", "heavy", "striker", "molotov", "flamer", "boomer", "runabout", "flak"],
          bastion: ["soldier", "sniper", "heavy", "mortar", "juggernaut", "tank", "artillery", "flak", "bomber"] };
        for (const f of ["vanguard", "syndicate", "bastion"]) {
          await js(`window.__rht.startBattle("verdant", "destroy", "normal", ${JSON.stringify(f)}, ${JSON.stringify(f === "vanguard" ? "bastion" : "vanguard")})`);
          await sleep(2600);
          for (const [id, kind, zoom] of SUBJ) {
            await js(`(() => { const r = window.__rht, sim = r.sim; sim.debugClearField(); const at = { x: 0, z: -9 };
              const e = ${JSON.stringify(kind)} === "base" ? sim.debugStructure("base", "player", at) : ${JSON.stringify(kind)} === "turret" ? sim.debugStructure("turret", "player", at) : sim.debugSpawn(${JSON.stringify(kind)}, "player", at);
              e.yaw = 0.35; r.deselect(); r.setView({ x: at.x, z: at.z, zoom: ${zoom}, pitch: 0.42, yaw: 1.2 }); })()`);
            await sleep(1600);
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(dir, `${id}-${f}.png`), img.toPNG());
            await js(`window.__rht.silhouette(true)`); await sleep(500);
            const sil = await win.webContents.capturePage();
            fs.writeFileSync(path.join(dir, `${id}-${f}-sil.png`), sil.toPNG());
            await js(`window.__rht.silhouette(false)`); await sleep(200);
          }
          for (const kind of ROSTERS[f]) {
            await js(`(() => { const r = window.__rht, sim = r.sim; sim.debugClearField(); const at = { x: 0, z: -9 };
              const e = sim.debugSpawn(${JSON.stringify(kind)}, "player", at); e.yaw = 0.35; if (e.flying) e.agl = 1.6; r.deselect(); // low enough to be in frame: the livery is measured, not the altitude
              const air = e.flying; r.setView({ x: at.x, z: at.z, zoom: air ? 0.62 : ${JSON.stringify(kind)} === "tank" || ${JSON.stringify(kind)} === "artillery" || ${JSON.stringify(kind)} === "flak" ? 0.5 : 0.3, pitch: air ? 0.62 : 0.42, yaw: 1.2 }); })()`);
            await sleep(1400);
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(dir, `roster-${kind}-${f}.png`), img.toPNG());
            await js(`window.__rht.silhouette(true)`); await sleep(400);
            const sil = await win.webContents.capturePage();
            fs.writeFileSync(path.join(dir, `roster-${kind}-${f}-sil.png`), sil.toPNG());
            await js(`window.__rht.silhouette(false)`); await sleep(200);
          }
        }
        console.log("shot: factions-measure (shared subjects + every roster unit, colour + silhouette)");
        win.setSize(1600, 900); await sleep(500);
        continue;
      }
      if (s === "apwarning") {
        // End Turn with units that still have action points: the prompt, with its "don't show again".
        await js(`window.__rht.scenario("firefight"); window.__rht.deselect();`);
        await sleep(1500);
        await clickMenu('[data-command="end"]');
        await shot("apwarning");
        await js(`document.querySelectorAll(".ap-warning").forEach((e) => e.remove())`);
        continue;
      }
      if (s === "settings") { await toTitle(); await clickMenu('[data-menu="settings"]'); await shot("settings"); continue; }
      if (s === "armory") { await toTitle(); await clickMenu('[data-menu="armory"]'); await shot("armory"); continue; }
      if (s === "achievements") { await toTitle(); await clickMenu('[data-menu="achievements"]'); await shot("achievements"); continue; }
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
        // The longest card (Shoot: how a shot treats a moving target), for fit.
        for (let i = 0; i < 4; i += 1) await js(`(() => { const b = document.querySelector('[data-tut="next"]'); if (b) b.click(); })()`);
        await sleep(800);
        await shot("tutorial-shoot");
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
        // A drone operator beside the ledge: its aura ring must follow the step like the move field does.
        await js(`(() => { const sim = window.__rht.sim; const r = sim.entities.filter(e => e.kind === "cover" && e.coverKind === "ridge")[0]; const m = sim.debugSpawn("skater", "player", { x: r ? r.position.x - r.radius - 1.2 : 2, z: r ? r.position.z + 1 : 2 }); window.__rht.deselect(); window.__rht.setView({ x: m.position.x, z: m.position.z, zoom: 0.5, pitch: 0.6, yaw: 0.25 }); })()`);
        await sleep(900);
        await shot("rings-aura");
        continue;
      }
      if (s === "climb") {
        // Move preview up a step (Ironworks slab): the path drapes over the lip and a ▲ CLIMB tag
        // stands on it. Three consecutive frames of the SELECTED trooper catch part flicker; then
        // deselected, then the queued order (same drape + tag after the click).
        await js(`window.__rht.startBattle("ironworks", "destroy", "normal")`);
        await sleep(2400);
        await js(`(() => { const r = window.__rht, s = r.sim; const u = s.debugSpawn("soldier", "player", { x: -14, z: 0 }); s.debugSelect(u.id); r.setIntent("move"); r.hoverGround({ x: -10.2, z: 0.3 }); r.setView({ x: -12, z: 0, zoom: 0.35, pitch: 0.75, yaw: 0 }); window.__climbId = u.id; })()`);
        await sleep(1200);
        for (const f of ["a", "b", "c"]) { await shot(`climb-select-${f}`); await sleep(120); }
        await js(`(() => { const r = window.__rht; r.hoverGround(undefined); r.setIntent("select"); r.sim.deselect(); })()`);
        await sleep(700);
        await shot("climb-deselected");
        await js(`(() => { const r = window.__rht, s = r.sim; s.debugSelect(window.__climbId); s.queueMove({ x: -10.2, z: 0.3 }); r.setIntent("select"); })()`);
        await sleep(700);
        await shot("climb-queued");
        continue;
      }
      if (s === "basedeploy") {
        // The owner's Ironworks frame: base selected, a Trooper deploy armed (green placement ring),
        // camera close. The dark wedge beside the base showed a sawtooth edge here.
        await js(`window.__rht.startBattle("ironworks", "destroy", "normal")`);
        await sleep(2400);
        await js(`(() => { const r = window.__rht, s = r.sim; const hq = s.entities.find(e => e.team === "player" && e.kind === "base"); s.select(hq.id); s.setPendingDeploy && s.setPendingDeploy("soldier"); r.setView({ x: hq.position.x + 2, z: hq.position.z, zoom: 0.5 }); })()`);
        await sleep(1200);
        await shot("basedeploy");
        if (process.env.PROBE) {
          // Bisect the edge teeth: without the deploy overlay, then with every light's shadow off.
          await js(`window.__rht.sim.setPendingDeploy(undefined)`); await sleep(700);
          await shot("basedeploy-nodisc");
          await js(`window.__rht.sceneObject().traverse((o) => { if (o.isLight) o.castShadow = false; })`); await sleep(700);
          await shot("basedeploy-noshadow");
        }
        continue;
      }
      if (s === "baseclose") {
        // CLOSE inspection of every base circle (owner: "circle of base going over something and being cut
        // off ... look closely at each"): both bases on every map, plain selection and deploy armed, from the
        // gameplay angle and from behind, HUD hidden so nothing covers the ring.
        for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(2000);
          await js(`document.body.classList.add("shots-hide-hud"); document.querySelectorAll("#ui, .hud, .topbar").forEach((e) => (e.style.visibility = "hidden"))`);
          for (const team of ["player", "enemy"]) {
            for (const [tag, deploy, yaw] of [["sel", false, 0.25], ["dep", true, 0.25], ["back", true, 0.25 + Math.PI]]) {
              await js(`(() => { const r = window.__rht, sim = r.sim; const hq = sim.entities.find(e => e.team === ${JSON.stringify(team)} && e.kind === "base"); sim.setPendingDeploy(undefined); sim.select(hq.id); if (${deploy} && hq.team === "player") sim.setPendingDeploy("soldier"); r.setView({ x: hq.position.x, z: hq.position.z, zoom: 0.95, pitch: 0.62, yaw: ${yaw} }); })()`);
              await sleep(700);
              await shot(`baseclose-${map}-${team}-${tag}`);
            }
          }
        }
        continue;
      }
      if (s === "defenses") {
        // Each faction's Defenses and Support decks fresh (starters open, the rest locked with their
        // doctrine), then with all research, a turret placement ghost under the cursor, and every
        // new emplacement standing by the base, close.
        for (const faction of ["vanguard", "syndicate", "bastion"]) {
          await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", ${JSON.stringify(faction)})`);
          await sleep(2400);
          const pick = async (tab) => { await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); })()`); await sleep(500); await js(`(() => { const b = document.querySelector('[data-base-tab="${tab}"]'); if (b) b.click(); })()`); await sleep(500); };
          await pick("defenses"); await shot(`defenses-${faction}-fresh`);
          await pick("support"); await shot(`support-${faction}-fresh`);
          await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000); const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); hq.unlockedTech = ["recon","assault","support","ordnance","armor","siege","airwing"]; })()`);
          await pick("defenses"); await shot(`defenses-${faction}-open`);
          await pick("support"); await shot(`support-${faction}-open`);
          // A turret ghost at a legal spot and at a refused one (inside the base).
          await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); sim.setPendingBuild("turret"); window.__rht.hoverGround({ x: hq.position.x + 6, z: hq.position.z + 2 }); window.__rht.setView({ x: hq.position.x + 5, z: hq.position.z + 1, zoom: 0.8, pitch: 0.75, yaw: 0.3 }); })()`);
          await sleep(900); await shot(`ghost-${faction}-ok`);
          await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); window.__rht.hoverGround({ x: hq.position.x + 13, z: hq.position.z + 2 }); window.__rht.setView({ x: hq.position.x + 8, z: hq.position.z + 1, zoom: 0.9, pitch: 0.75, yaw: 0.3 }); })()`);
          await sleep(700); await shot(`ghost-${faction}-refused`);
          // The faction's top support's reticle (napalm / paradrop / barrage), out in the field.
          await js(`(() => { const sim = window.__rht.sim; sim.setPendingBuild(undefined); const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); const kind = sim.factionOf("player").supports.find((k) => ["paradrop", "napalm", "barrage"].includes(k)); sim.setPendingSupport(kind); window.__rht.hoverGround({ x: 0, z: 0 }); window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.8, yaw: 0.3 }); })()`);
          await sleep(800); await shot(`reticle-${faction}`);
          await js(`window.__rht.sim.setPendingSupport(undefined)`);
          await js(`(() => { const sim = window.__rht.sim; sim.setPendingBuild(undefined); window.__rht.deselect(); const hq = sim.entities.find(e => e.team === "player" && e.kind === "base");
            const kinds = sim.factionOf("player").defenses.filter((k) => k !== "minefield" && k !== "sandbag");
            kinds.forEach((k, i) => sim.debugBuild(k, "player", { x: hq.position.x + 7 + (i % 3) * 3.2, z: hq.position.z - 3 + Math.floor(i / 3) * 3.6 }));
            window.__rht.setView({ x: hq.position.x + 10, z: hq.position.z - 1, zoom: 0.7, pitch: 0.7, yaw: 0.45 }); })()`);
          await sleep(1200); await shot(`emplacements-${faction}`);
        }
        continue;
      }
      if (s === "fieldhands") {
        // The 2026-10-03 units and objects: the roster close up, every placement standing, the place ghost,
        // the command card of a field hand, an oil fire, and a shove filmstrip (stagger, not a half-flip).
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", "vanguard")`);
        await sleep(2200);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("player", 9000);
          ["bazooka","breaker","boomer","juggernaut"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -20 + i * 1.5, z: 0 }); u.yaw = Math.PI + 0.35; });
          r.setView({ x: -17, z: -0.8, zoom: 0.22, pitch: 0.4, yaw: 0.5 }); })()`);
        await sleep(2500); await shot("fieldhands-lineup");
        await js(`(() => { const r = window.__rht, sim = r.sim; r.setView({ x: -17, z: -0.8, zoom: 0.16, pitch: 0.34, yaw: -0.5 }); })()`);
        await sleep(1200); await shot("fieldhands-lineup-back");
        // Everything placed, in one frame.
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect();
          sim.debugStructure("mortarpit", "player", { x: 12, z: 4 });
          r.setView({ x: 3, z: 0, zoom: 0.55, pitch: 0.75, yaw: 0.3 }); })()`);
        await sleep(1500); await shot("fieldhands-placed");
        await js(`(() => { const r = window.__rht, sim = r.sim; r.setIntent("select"); r.hoverGround(undefined); })()`);
        await sleep(600); await shot("fieldhands-card");
        // A shove, six frames: lean and recover.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2000);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const a = sim.debugSpawn("soldier", "player", { x: -3, z: 0 }); const b = sim.debugSpawn("soldier", "enemy", { x: -0.6, z: 0 }); for (const p of b.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; b.status.canShoot = false; b.status.canMove = false; sim.debugSelect(a.id); sim.queueShove(b.id); r.setView({ x: 0, z: 0, zoom: 0.35, pitch: 0.5, yaw: 0.9 }); sim.endTurn(); })()`);
        for (let i = 0; i < 6; i += 1) { await sleep(i === 0 ? 700 : 170); await shot("shove-" + i); }
        continue;
      }
      if (s === "mounts") {
        // Crewing a gun: Man armed (free posts pulse), the walk-up and seat, then the crewed post selected.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2200);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const post = sim.entities.find(e => e.kind === "gunpost"); const u = sim.debugSpawn("soldier", "player", { x: post.position.x - 7, z: post.position.z }); sim.debugSelect(u.id); r.setIntent("man"); r.setView({ x: post.position.x - 3, z: post.position.z, zoom: 0.55, pitch: 0.7, yaw: 0.3 }); window.__crew = u.id; window.__post = post.id; })()`);
        await sleep(1100); await shot("mounts-man-armed");
        await js(`(() => { const r = window.__rht, sim = r.sim; const post = sim.entity(window.__post); r.hud ? 0 : 0; sim.queueMan(post.id); r.setIntent("select"); sim.endTurn(); })()`);
        for (let i = 0; i < 3; i += 1) { await sleep(i === 0 ? 900 : 700); await shot("mounts-walk-" + i); }
        await sleep(3000);
        await js(`(() => { const r = window.__rht, sim = r.sim; const post = sim.entity(window.__post); sim.debugSelect(post.id); r.setView({ x: post.position.x, z: post.position.z, zoom: 0.5, pitch: 0.7, yaw: 0.3 }); })()`);
        await sleep(1000); await shot("mounts-crewed");
        continue;
      }
      if (s === "audioprobe") {
        // Every map picks one of ITS three tracks, and every sample + track file is served (no 404s).
        const pools = { dustbowl: ["desert_loop","negev_desert","negev_fight"], ironworks: ["factory","wowchapter1","wowchapter3"], verdant: ["harvest_season","fantasy_orchestral","wowchapter2"], causeway: ["long_winter","november_snow","crystal_cave"], karak: ["epic_boss","battleThemeA","crystal_cave"], crossfire: ["march2","battleThemeA","wowchapter2"] };
        for (const map of Object.keys(pools)) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(1500);
          const track = await js(`window.__rht.musicTrack()`);
          const ok = await js(`fetch(new URL("audio/music/" + window.__rht.musicTrack() + ".ogg", document.baseURI)).then((r) => r.status)`);
          console.log("audioprobe", map, track, pools[map].includes(track) ? "in-pool" : "WRONG POOL", "http", ok);
        }
        const missing = await js(`(async () => { const names = ["rifle","carbine","pistol","pellet","bolt_01","cannon_01","blast_01","boomdeep_01","pop_01","crack_01","hitmetal_000","hitpunch_000","hitsoft_000","hitplate_000","hitwood_000"]; const bad = []; for (const n of names) { const r = await fetch(new URL("audio/sfx/" + n + ".ogg", document.baseURI)); if (!r.ok) bad.push(n); } return JSON.stringify(bad); })()`);
        console.log("audioprobe missing sfx:", missing);
        continue;
      }
      if (s === "projectiles") {
        // Every small-arms round side by side, mid-flight: rifle, carbine, pistol, machine gun, marksman, rocket. No long detached tail.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2000);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0);
          const kinds = ["soldier", "skater", "striker", "heavy", "sniper", "bazooka"];
          kinds.forEach((k, i) => { const z = -7.5 + i * 3; const a = sim.debugSpawn(k, "player", { x: -10, z }); const t = sim.debugSpawn("tank", "enemy", { x: 4, z }); for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false; sim.debugSelect(a.id); sim.queueShoot(t.id); });
          r.setView({ x: -3, z: 0, zoom: 0.5, pitch: 0.8, yaw: 0.0 }); sim.endTurn(); })()`);
        for (let i = 0; i < 8; i += 1) { await sleep(i === 0 ? 900 : 230); await shot("proj-" + i); }
        continue;
      }
      if (s === "circles") {
        // Every ring that lies on the ground, across ledges: the Hill ring on all six maps, a cash cache and a depot beside a step.
        for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "hill", "normal")`);
          await sleep(1800);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const h = sim.modeState.hill; r.setView({ x: h.x, z: h.z, zoom: 0.5, pitch: 0.85, yaw: 0.2 }); })()`);
          await sleep(700);
          await shot("circle-hill-" + map);
        }
        continue;
      }
      if (s === "controls3") {
        // Base deck quick-select numbers, Tab cycling to the Home Base, the all-set End Turn, the custom cursor classes and a hop preview.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2000);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); })()`);
        await sleep(700); await shot("controls-basedeck");
        await js(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "BracketRight" }))`);
        await sleep(500); await shot("controls-basedeck-tab2");
        console.log("controls3 digits", await js(`document.querySelectorAll(".slot-key").length`));
        // Tab from nothing selected lands on the Home Base first
        await js(`(() => { const r = window.__rht; r.deselect(); window.dispatchEvent(new KeyboardEvent("keydown", { code: "Tab" })); })()`);
        await sleep(300);
        console.log("controls3 tab selected", await js(`window.__rht.sim.selected && window.__rht.sim.selected.kind`));
        // a hop preview + the all-set button
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const u = sim.debugSpawn("skater", "player", { x: -12, z: 6 }); sim.debugSelect(u.id); r.setIntent("leap"); r.hoverGround({ x: -9, z: 6 }); r.setView({ x: -11, z: 6, zoom: 0.5, pitch: 0.8, yaw: 0.2 }); })()`);
        await sleep(900); await shot("controls-hop");
        await js(`(() => { const r = window.__rht, sim = r.sim; r.setIntent("select"); r.hoverGround(undefined); for (const e of sim.entities) if (e.team === "player" && e.kind !== "base") e.commandPoints = 0; })()`);
        await sleep(900); await shot("controls-allset");
        console.log("controls3 cursor", await js(`document.body.className`));
        // THE CURSORS really apply and their SVGs decode: default, hover-a-button, attack reticle, move ring.
        const cursors = await js(`(async () => {
          const out = {};
          const probe = async (label, el) => { const c = getComputedStyle(el).cursor; const a = c.indexOf('url("'), b = c.lastIndexOf('")'); const m = a >= 0 && b > a ? [0, c.slice(a + 5, b)] : null; let ok = false; if (m) { const img = new Image(); img.src = m[1]; try { await img.decode(); ok = img.naturalWidth > 0; } catch { ok = false; } } out[label] = { hasUrl: Boolean(m), decodes: ok, raw: m ? undefined : c.slice(0, 80) }; };
          await probe("default", document.getElementById("game"));
          const btn = document.querySelector("#ui button"); if (btn) await probe("button", btn);
          document.body.classList.add("cursor-aim"); await probe("aim", document.getElementById("game")); document.body.classList.remove("cursor-aim");
          document.body.classList.add("cursor-move"); await probe("move", document.getElementById("game")); document.body.classList.remove("cursor-move");
          return JSON.stringify(out);
        })()`);
        console.log("controls3 cursors", cursors);
        if (/"hasUrl":false|"decodes":false/.test(cursors)) throw new Error("a custom cursor does not apply or its SVG does not decode: " + cursors);
        // FIELD CACHE AS A DESTINATION: with Move armed, a real click on a cache queues a move onto it, and the unit banks it.
        const cache = await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const c = sim.pickups[0]; const u = sim.debugSpawn("skater", "player", { x: c.x - 6, z: c.z }); sim.debugSelect(u.id); r.setView({ x: c.x - 3, z: c.z, zoom: 0.5, pitch: 0.85, yaw: 0 }); window.__cacheUnit = u.id; return JSON.stringify({ x: c.x, z: c.z, amount: c.amount, money: sim.money("player"), n: sim.pickups.length }); })()`);
        await sleep(900);
        await js(`document.querySelector('[data-order-action="move"]').click()`);
        await sleep(300);
        const c = JSON.parse(cache);
        await js(`window.__rht.hud && 0; window.__rht.clickWorld({ x: ${c.x}, z: ${c.z} }, 0.5)`);
        await sleep(300);
        const queued = await js(`JSON.stringify(window.__rht.sim.orders.filter((o) => o.actorId === window.__cacheUnit).map((o) => ({ k: o.kind, d: o.destination })))`);
        console.log("controls3 cache click queued", queued);
        await js(`window.__rht.endTurn()`);
        for (let i = 0; i < 60; i += 1) { await sleep(250); if (await js(`window.__rht.sim.phase === "command"`)) break; }
        const after = JSON.parse(await js(`JSON.stringify({ money: window.__rht.sim.money("player"), n: window.__rht.sim.pickups.length })`));
        console.log("controls3 cache banked", JSON.stringify({ before: c.money, after: after.money, gain: after.money - c.money, expected: c.amount, cachesLeft: after.n, was: c.n }));
        if (!(after.n < c.n)) throw new Error("clicking a field cache with Move armed did not send the unit onto it");
        continue;
      }
      if (s === "groundaim") {
        // Splash aiming: arm Shoot on a tank, click a ground spot (preview line stays put, hover moves nothing), then Confirm queues exactly that spot.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1800);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const u = sim.debugSpawn("tank", "player", { x: -10, z: 0 }); sim.debugSelect(u.id); r.setView({ x: -5, z: 0, zoom: 0.5, pitch: 0.85, yaw: 0.2 }); })()`);
        await sleep(500);
        await js(`document.querySelector('[data-order-action="shoot"]').click()`);
        await sleep(300);
        await js(`window.__rht.clickWorld({ x: -3, z: 2 }, 0)`);
        await sleep(300);
        await js(`window.__rht.hoverGround({ x: 3, z: -4 })`); // the cursor wanders: the line must not follow
        await sleep(700); await shot("groundaim-picked");
        const has = await js(`Boolean(document.querySelector('[data-confirm="ground"]'))`);
        console.log("groundaim confirm button", has, await js(`document.querySelector(".target-summary")?.textContent?.replace(/\\s+/g, " ")`));
        if (!has) throw new Error("picking a ground spot did not offer Confirm");
        await js(`document.querySelector('[data-confirm="ground"]').click()`);
        await sleep(300);
        const orders = await js(`JSON.stringify(window.__rht.sim.orders.map((o) => ({ k: o.kind, d: o.destination })))`);
        console.log("groundaim orders", orders);
        const d = JSON.parse(orders)[0]?.d;
        if (!d || Math.hypot(d.x + 3, d.z - 2) > 1.2) throw new Error("confirm did not fire at the picked spot: " + orders);
        continue;
      }
      if (s === "karakclip") {
        await js(`window.__rht.startBattle("karak", "destroy", "normal")`);
        await sleep(1800);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const t = sim.debugSpawn("tank", "player", { x: -13, z: -14.8 }); r.setView({ x: -13, z: -14.8, zoom: 0.3, pitch: 0.6, yaw: 0.3 }); })()`);
        await sleep(900); await shot("karakclip");
        console.log("karakclip", await js(`JSON.stringify(window.__rht.auditTerrainClip())`));
        continue;
      }
      if (s === "knockfilm") {
        // The fly-back, isolated: a trooper is jumped 2.5m, 5m and 7m by teleport during a resolve (the renderer animates any such jump as a throw).
        for (const d of [2.5, 5, 7]) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
          await sleep(1500);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); const t = sim.debugSpawn("soldier", "enemy", { x: -4, z: 0 }); for (const p of t.parts) if (p.role === "weapon") p.hp = 0; t.status.canShoot = false; t.status.canMove = false; window.__thrown = t.id; const a = sim.debugSpawn("soldier", "player", { x: -14, z: 6 }); sim.debugSelect(a.id); sim.queueMove({ x: -13, z: 6 }); r.deselect(); r.setView({ x: -4 + ${d} / 2, z: 0, zoom: 0.4, pitch: 0.55, yaw: 0.5 }); sim.endTurn(); })()`);
          await sleep(500);
          await js(`(() => { const e = window.__rht.sim.entity(window.__thrown); window.__rht.setTimeScale(0.5); e.position = { x: e.position.x + ${d}, z: e.position.z }; })()`);
          for (let i = 0; i < 12; i += 1) { await sleep(i === 0 ? 40 : 110); await shot("knock-" + d + "-" + i); }
        }
        await js(`window.__rht.setTimeScale(1)`);
        continue;
      }
      if (s === "clash") {
        // Rounds meeting in the air: rifles, a sniper pair, two tank shells. The enemy round is injected head-on (natural meetings are rare), slow motion.
        for (const [label, kindA, kindB, shotKind] of [["rifle", "soldier", "soldier", "plain"], ["sniper", "sniper", "sniper", "plain"], ["shell", "tank", "tank", "plain"], ["grenade", "soldier", "soldier", "grenade"]]) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
          await sleep(1400);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); const a = sim.debugSpawn(${JSON.stringify(kindA)}, "player", { x: -9, z: 0 }); const b = sim.debugSpawn(${JSON.stringify(kindB)}, "enemy", { x: 9, z: 0 }); for (const p of b.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; b.status.canShoot = false; b.status.canMove = false; window.__clashEnemy = b.id; sim.debugSelect(a.id); sim.queueShoot(b.id); r.setView({ x: 0, z: 0, zoom: 0.3, pitch: 0.55, yaw: 0.35 }); r.setTimeScale(0.2); sim.endTurn(); })()`);
          let injected = false;
          for (let i = 0; i < 260 && !injected; i += 1) {
            await sleep(60);
            injected = await js(`(() => { const sim = window.__rht.sim; const mine = sim.projectiles[0]; if (!mine) return false; const ahead = 3.2; const o = { x: mine.position.x + mine.direction.x * ahead, z: mine.position.z + mine.direction.z * ahead }; const other = structuredClone(mine); Object.assign(other, { id: "injected", actorId: window.__clashEnemy, orderId: "none", targetId: undefined, kind: ${JSON.stringify(shotKind)} === "grenade" ? "grenade" : mine.kind, sourceKind: ${JSON.stringify(kindB)}, direction: { x: -mine.direction.x, z: -mine.direction.z }, origin: o, position: { ...o }, previous: { ...o }, travel: 0, maxTravel: 30, age: 0, maxAge: 10, height: mine.height, previousHeight: mine.height, originHeight: ${JSON.stringify(shotKind)} === "grenade" ? 1.2 : mine.height, verticalSlope: 0, arcHeight: 0 }); sim.projectiles.push(other); return true; })()`);
          }
          console.log("clash", label, "injected", injected);
          for (let i = 0; i < 10; i += 1) { await sleep(i === 0 ? 150 : 330); await shot("clash-" + label + "-" + i); }
          console.log("clash", label, JSON.stringify(await js(`window.__rht.sim.log.slice(0, 6)`)));
        }
        await js(`window.__rht.setTimeScale(1)`);
        continue;
      }
      if (s === "newunits") {
        // The eight newest troop types, each faction's own four, on the line: both teams, close, one frame per faction.
        for (const f of ["vanguard", "syndicate", "bastion"]) {
          const kinds = { vanguard: ["runabout", "hookshot", "skater", "breaker"], syndicate: ["runabout", "molotov", "sledge", "boomer"], bastion: ["runabout", "mole", "bulldozer", "juggernaut"] }[f];
          await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", ${JSON.stringify(f)}, ${JSON.stringify(f)})`);
          await sleep(1500);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
            ${JSON.stringify(kinds)}.forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -6 + i * 3.4, z: 2 }); u.yaw = 0.4; const e = sim.debugSpawn(k, "enemy", { x: -6 + i * 3.4, z: -3.5 }); e.yaw = Math.PI + 0.4; for (const p of e.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; e.status.canShoot = false; e.status.canMove = false; });
            r.setView({ x: 0, z: -0.8, zoom: 0.3, pitch: 0.55, yaw: 0.25 }); })()`);
          await sleep(1200);
          await shot("newunits-" + f);
        }
        await js(`document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = ""))`);
        continue;
      }
      if (s === "review") {
        // Harsh review: each new kind selected with the real HUD up (order panel), plus base upgrades, burning and sentries at play zoom.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", "syndicate", "vanguard")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("player", 9000); sim.economy.set("enemy", 0);
          const kinds = ["sledge", "boomer", "runabout", "mole", "flamer", "breaker", "juggernaut", "bulldozer", "hookshot", "chopbike"];
          kinds.forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -20 + i * 2.6, z: 4 }); u.yaw = 0.3; });
          const foe = sim.debugSpawn("soldier", "enemy", { x: -6, z: -4 }); foe.burning = { turns: 3, dmg: 8 };
          const f2 = sim.debugSpawn("tank", "enemy", { x: -2, z: -3 });
          r.setView({ x: -6, z: 2, zoom: 0.5, pitch: 0.6, yaw: 0.2 }); })()`);
        await sleep(1000);
        for (const k of ["sledge", "boomer", "runabout", "mole", "flamer", "breaker", "juggernaut", "bulldozer", "hookshot", "chopbike"]) {
          await js(`(() => { const sim = window.__rht.sim; const u = sim.entities.find((e) => e.team === "player" && e.kind === ${JSON.stringify(k)}); sim.select(u.id); })()`);
          await sleep(500);
          await shot("review-" + k);
        }
        await js(`(() => { const sim = window.__rht.sim; const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); sim.select(base.id); })()`);
        await sleep(400);
        await js(`(() => { const b = document.querySelector('[data-base-tab="upgrade"]'); if (b) b.click(); })()`);
        await sleep(500); await shot("review-base-upgrade");
        continue;
      }
      if (s === "strikes") {
        // The five new support strikes, filmed: EMP, minefield, medevac, sentry drop, rail strike.
        for (const [fac, kind] of [["syndicate", "smokescreen"], ["syndicate", "minedrop"], ["syndicate", "railstrike"], ["vanguard", "sentrydrop"]]) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal", ${JSON.stringify(fac)}, "vanguard")`);
          await sleep(1500);
          const info = await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("player", 9000); sim.economy.set("enemy", 0);
            const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); base.unlockedTech = sim.techIds ? sim.techIds() : ["recon","assault","armor","support","radar","motorpool","siege","airwing","shock","ordnance","incendiary","demolition","fieldworks","optics","marksman","breach","bulwark","thermobarics","cluster","plating","hunter","ghillie"];
            const bx = base.position.x;
            const tgt = { x: bx + 14, z: 0 };
            const foes = [];
            for (const [dx, dz, k] of [[0, 0, "soldier"], [1.6, 1.2, "soldier"], [-1.4, 1.4, "heavy"], [0.4, -1.8, "tank"]]) { const e = sim.debugSpawn(k, "enemy", { x: tgt.x + dx, z: tgt.z + dz }); for (const p of e.parts) if (p.role === "weapon") p.hp = 0; e.status.canShoot = false; foes.push(e.id); }
            const mate = sim.debugSpawn("soldier", "player", { x: bx + 9, z: 3 }); mate.parts[0].hp = Math.max(1, mate.parts[0].hp * 0.3); mate.status.alive = true;
            sim.select(base.id); sim.pendingSupport = ${JSON.stringify(kind)};
            const ok = sim.queueSupportAt(${kind === "medevac" ? "{ x: bx + 9, z: 3 }" : "tgt"});
            r.setView({ x: ${kind === "medevac" ? "bx + 9" : "tgt.x"}, z: 1, zoom: 0.3, pitch: 0.6, yaw: 0.3 }); r.deselect();
            const log = sim.log.slice(-3).map((l) => l.text ?? l);
            if (ok) { sim.endTurn(); r.setTimeScale(0.8); }
            return JSON.stringify({ ok, log }); })()`);
          console.log("strike", kind, info);
          for (let i = 0; i < 14; i += 1) { await sleep(i === 0 ? 250 : 300); await shot("strike-" + kind + "-" + i); if (process.env.PROBE && i === 3) console.log("cubes", await js(`(() => { const out = {}; window.__rht.sceneObject().traverse((o) => { if (!o.isMesh && !o.isInstancedMesh) return; const c = o.material && o.material.color; if (!c) return; const h = c.getHexString(); if (c.r > 0.7 && c.g < 0.5 && c.b < 0.45) { let p = o, chain = []; while (p && chain.length < 5) { chain.push(p.name || p.type); p = p.parent; } const k = h + " " + chain.join("<"); out[k] = (out[k] || 0) + (o.isInstancedMesh ? o.count : 1); } }); return JSON.stringify(out); })()`)); }
          await js(`window.__rht.setTimeScale(1)`);
        }
        continue;
      }
      if (s === "airaim") {
        // Air bombing: arm Bomb on a gunship, click a ground spot 6m off (the line from the rack + the splash stay put, no move is queued), Confirm, film the fall.
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1800);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0);
          const g = sim.debugSpawn("gunship", "player", { x: -12, z: 0 }); g.yaw = Math.PI / 2;
          for (const [x, z] of [[-6, 1], [-5, -1.4], [-7.4, -0.6]]) { const e = sim.debugSpawn("soldier", "enemy", { x, z }); e.status.canShoot = false; e.status.canMove = false; }
          sim.debugSelect(g.id); r.setView({ x: -8.5, z: 0, zoom: 0.4, pitch: 0.7, yaw: 0.35 }); })()`);
        await sleep(600);
        await js(`document.querySelector('[data-order-action="grenade"]').click()`);
        await sleep(300);
        await js(`window.__rht.clickWorld({ x: -6, z: 0 }, 0)`);
        await sleep(300);
        await js(`window.__rht.hoverGround({ x: 3, z: -6 })`);
        await sleep(800); await shot("airaim-picked");
        console.log("airaim confirm", await js(`JSON.stringify({ btn: Boolean(document.querySelector('[data-confirm="ground"]')), note: document.querySelector(".target-summary")?.textContent?.replace(/\s+/g, " ") })`));
        await js(`document.querySelector('[data-confirm="ground"]').click()`);
        await sleep(300);
        console.log("airaim orders", await js(`JSON.stringify(window.__rht.sim.orders.map((o) => ({ k: o.kind, d: o.destination })))`));
        await shot("airaim-queued");
        await js(`window.__rht.sim.endTurn(); window.__rht.setTimeScale(0.5)`);
        for (let i = 0; i < 8; i += 1) { await sleep(i === 0 ? 300 : 220); await shot("airaim-fall-" + i); }
        await js(`window.__rht.setTimeScale(1)`);
        continue;
      }
      if (s === "muzzles") {
        // One shooter per kind, mid-flight of its first round, tight on the muzzle: the round must leave the gun, not float above it.
        const kinds = ["gunship", "soldier", "sniper", "bazooka", "flamer", "tank", "chopbike", "runabout", "flak", "artillery"];
        for (const kind of kinds) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
          await sleep(1300);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
            const a = sim.debugSpawn(${JSON.stringify(kind)}, "player", { x: -10, z: 0 }); a.yaw = Math.PI / 2;
            const t = sim.debugSpawn("tank", "enemy", { x: -1, z: 0 }); for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false;
            sim.debugSelect(a.id); sim.queueShoot(t.id); sim.endTurn(); r.setTimeScale(0.35);
            const h = a.elevation; r.setView({ x: -9.2, z: 0, zoom: 0.16, pitch: 0.35, yaw: 0.9 }); })()`);
          await sleep(900);
          await shot("muzzle-" + kind);
        }
        await js(`window.__rht.setTimeScale(1); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = ""))`);
        continue;
      }
      if (s === "muzzlecheck") {
        // DATA, not pictures: for every shooter, fire one round and measure how far the sim's round origin is from the nearest drawn weapon-part box.
        const kinds = ["gunship", "soldier", "sniper", "heavy", "skater", "striker", "molotov", "mortar", "bazooka", "flamer", "hookshot", "bulldozer", "mole", "breaker", "juggernaut", "tank", "chopbike", "runabout", "flak", "artillery"];
        const rows = [];
        for (const kind of kinds) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
          await sleep(900);
          const id = await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0);
            const a = sim.debugSpawn(${JSON.stringify(kind)}, "player", { x: -10, z: 0 });
            const t = sim.debugSpawn("tank", "enemy", { x: -2, z: 0 }); for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false;
            sim.debugSelect(a.id); const ok = sim.queueShoot(t.id) || (sim.setIntent && 0); sim.endTurn();
            for (let i = 0; i < 400 && sim.projectiles.length === 0; i += 1) sim.update(0.02);
            return a.id; })()`);
          await sleep(400);
          const row = await js(`(() => { const r = window.__rht, sim = r.sim; const a = sim.entity(${JSON.stringify(id)}); const p = sim.projectiles[0];
            if (!p) return JSON.stringify({ kind: ${JSON.stringify(kind)}, note: "no round" });
            const weaponIds = new Set(a.parts.filter((x) => x.role === "weapon").map((x) => x.id));
            const THREE_Box = (r.sceneObject().constructor && null);
            let best = Infinity, count = 0, names = [];
            const o = p.origin, oy = p.originHeight;
            r.sceneObject().traverse((m) => { if (!m.isMesh || m.userData.entityId !== a.id || !weaponIds.has(m.userData.partId)) return; count += 1;
              m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld);
              const dx = Math.max(b.min.x - o.x, 0, o.x - b.max.x), dy = Math.max(b.min.y - oy, 0, oy - b.max.y), dz = Math.max(b.min.z - o.z, 0, o.z - b.max.z);
              const d = Math.hypot(dx, dy, dz); if (d < best) best = d; });
            return JSON.stringify({ kind: ${JSON.stringify(kind)}, weaponMeshes: count, gapToWeapon: count ? +best.toFixed(2) : null, originH: +(oy - a.elevation).toFixed(2) }); })()`);
          rows.push(row);
        }
        console.log("MUZZLECHECK " + rows.join(" ;; "));
        continue;
      }
      if (s === "techui") {
        // The rebuilt tech tree on each faction's board, nothing researched, and mid-game.
        for (const f of ["vanguard", "syndicate", "bastion"]) {
          await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", ${JSON.stringify(f)}, "vanguard")`);
          await sleep(1500);
          const open = async (tab) => { await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000); const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); sim.select(base.id); })()`); await sleep(400); await js(`(() => { const b = document.querySelector('[data-base-tab="${tab}"]'); if (b) b.click(); })()`); await sleep(500); };
          await open("tech");
          await shot("techui-" + f);
          if (f === "syndicate") {
            await js(`(() => { const base = window.__rht.sim.entities.find((e) => e.team === "player" && e.kind === "base"); base.unlockedTech = ["recon", "assault", "ordnance", "incendiary", "shock", "motorpool"]; })()`);
            await open("tech"); await shot("techui-syndicate-mid");
            await open("upgrade"); await shot("baseupgrades-syndicate");
            await open("support"); await shot("supports-syndicate");
            await open("defenses"); await shot("defenses-syndicate");
            await open("deploy"); await shot("deploy-syndicate");
          }
        }
        continue;
      }
      if (s === "posts") {
        // The map's field posts: gun, rocket and flame, close.
        await js(`window.__rht.startBattle("karak", "destroy", "normal")`);
        await sleep(1500);
        for (const kind of ["gunpost", "rocketpost", "flamepost"]) {
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden")); const p = sim.entities.find((e) => e.kind === ${JSON.stringify(kind)}); r.setView({ x: p.position.x, z: p.position.z, zoom: 0.2, pitch: 0.55, yaw: 0.4 }); })()`);
          await sleep(900);
          await shot("post-" + kind);
        }
        await js(`document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = ""))`);
        continue;
      }
      if (s === "slamfilm") {
        // The hammer: a Sledge amid three foes, slow motion, the swing and the throw.
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); const s = sim.debugSpawn("sledge", "player", { x: -6, z: 0 }); for (const [x, z] of [[-4.6, 0.4], [-6.4, 1.8], [-7.4, -1.2]]) { const e = sim.debugSpawn("soldier", "enemy", { x, z }); for (const p of e.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; e.status.canShoot = false; e.status.canMove = false; } sim.debugSelect(s.id); sim.queueSlam(); r.setView({ x: -6, z: 0.4, zoom: 0.24, pitch: 0.55, yaw: 0.5 }); r.deselect(); sim.endTurn(); r.setTimeScale(0.4); })()`);
        for (let i = 0; i < 12; i += 1) { await sleep(i === 0 ? 300 : 160); await shot("slam-" + i); }
        await js(`window.__rht.setTimeScale(1)`);
        continue;
      }
      if (s === "toast") {
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`window.__rht.toastMedal("slam10")`);
        await sleep(800);
        await shot("achieve-toast");
        continue;
      }
      if (s === "projgallery") {
        // One shooter at a time, tight camera on the round in flight: three frames each. Rifle, carbine, pistol, MG, marksman, rocket, scattergun, grenade.
        const kinds = ["soldier", "skater", "striker", "heavy", "sniper", "bazooka", "molotov"];
        for (const kind of kinds) {
          await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
          await sleep(1400);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); document.body.classList.add("shots-hide-hud"); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
            const a = sim.debugSpawn(${JSON.stringify(kind)}, "player", { x: -12, z: 0 }); const t = sim.debugSpawn("tank", "enemy", { x: 2, z: 0 }); for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false;
            sim.debugSelect(a.id); sim.queueShoot(t.id); r.setView({ x: -5, z: 0, zoom: 0.26, pitch: 0.65, yaw: 0.35 }); sim.endTurn(); })()`);
          for (let i = 0; i < 4; i += 1) { await sleep(i === 0 ? 650 : 140); await shot(`pg-${kind}-${i}`); }
        }
        continue;
      }
      if (s === "projfollow") {
        // The camera rides each round (tight, HUD hidden) and grabs the frame at mid-flight: the round itself, close.
        const kinds = (process.env.KINDS || "soldier,skater,jumper,hookshot,bulldozer,breaker,juggernaut,striker,sledge,mole,molotov,heavy,sniper,bazooka,grenadier,tank,mortar").split(",");
        for (const kind of kinds) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
          await sleep(1300);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
            const a = sim.debugSpawn(${JSON.stringify(kind)}, "player", { x: -14, z: 0 }); const t = sim.debugSpawn("tank", "enemy", { x: 6, z: 0 }); for (const p of t.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0; t.status.canShoot = false; t.status.canMove = false;
            sim.debugSelect(a.id); sim.queueShoot(t.id); sim.endTurn(); window.__rht.setTimeScale(0.25); })()`);
          let got = false;
          for (let i = 0; i < 400 && !got; i += 1) {
            await sleep(40);
            const st = JSON.parse(await js(`JSON.stringify(window.__rht.sim.projectiles.slice(0, 1).map((p) => ({ x: p.position.x, z: p.position.z, t: p.travel })))`));
            if (st.length) {
              await js(`window.__rht.setView({ x: ${st[0].x}, z: ${st[0].z}, zoom: 0.14, pitch: 1.3, yaw: 0.0 })`);
              if (st[0].t > 3.2) {
                // re-centre on where the round is NOW (the first read is a frame old), then grab it
                await sleep(25);
                const now = JSON.parse(await js(`JSON.stringify(window.__rht.sim.projectiles.slice(0, 1).map((p) => ({ x: p.position.x, z: p.position.z })))`));
                if (now.length) await js(`window.__rht.setView({ x: ${now[0].x + 0.35}, z: ${now[0].z}, zoom: 0.14, pitch: 1.3, yaw: 0.0 })`);
                await shot("pf-" + kind); got = true;
              }
            }
          }
          if (!got) console.log("projfollow: no frame for", kind);
        }
        continue;
      }
      if (s === "fununits") {
        // Round 6: the Breaker, Boomer and Juggernaut close up (each in its own faction's look), then each verb mid-action.
        for (const [f, k] of (process.env.FUN ? process.env.FUN.split(",").map((x) => x.split(":")) : [["vanguard", "breaker"], ["syndicate", "boomer"], ["bastion", "juggernaut"], ["vanguard", "hookshot"], ["vanguard", "skater"], ["syndicate", "molotov"], ["bastion", "mole"]])) {
          await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal", ${JSON.stringify(f)}, ${JSON.stringify(f)})`);
          await sleep(1500);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
            const a = sim.debugSpawn(${JSON.stringify(k)}, "player", { x: -4, z: -8 }); a.yaw = 0.5; const b = sim.debugSpawn(${JSON.stringify(k)}, "player", { x: -1.6, z: -8 }); b.yaw = Math.PI + 0.5;
            r.setView({ x: -2.8, z: -8, zoom: 0.14, pitch: 0.42, yaw: 0.3 }); })()`);
          await sleep(1200); await shot("fun-" + k);
          // The verb: Breaker punches a trooper, Boomer runs in and blows, Juggernaut fires at a trooper.
          await js(`(() => { const r = window.__rht, sim = r.sim; for (const e of sim.entities) if (e.team === "player" && e.kind === ${JSON.stringify(k)}) e.status.alive = false;
            for (let i = sim.entities.length - 1; i >= 0; i -= 1) { const e = sim.entities[i]; if (e.kind === "cover" && e.coverKind === "convoy") sim.entities.splice(i, 1); } // a clear lane
            const a = sim.debugSpawn(${JSON.stringify(k)}, "player", { x: -12, z: -8 }); a.yaw = Math.PI / 2;
            const foes = [0, 1.6, -1.6].map((dz) => { const t = sim.debugSpawn("soldier", "enemy", { x: ${k === "juggernaut" || k === "hookshot" || k === "molotov" ? -1 : -6.5}, z: -8 + dz }); t.commandPoints = 0; return t; });
            sim.debugSelect(a.id);
            if (${JSON.stringify(k)} === "breaker") sim.queueShove(foes[0].id);
            else if (${JSON.stringify(k)} === "boomer") { sim.queueMove({ x: -7.8, z: -8 }); sim.queueDetonate(); }
            else if (${JSON.stringify(k)} === "skater" || ${JSON.stringify(k)} === "chopbike") sim.queueMove({ x: -2, z: -8.2 });
            else if (${JSON.stringify(k)} === "bulldozer") sim.queueMove({ x: -4, z: -8 });
            else if (${JSON.stringify(k)} === "jumper") sim.queueMove({ x: -6.5, z: -8 });
            else if (${JSON.stringify(k)} === "mole") sim.queueMove({ x: -6.2, z: -8 });
            else sim.queueShoot(foes[0].id);
            r.setView({ x: -6, z: -8, zoom: 0.3, pitch: 0.6, yaw: 0.2 }); sim.endTurn(); window.__rht.setTimeScale(0.5); })()`);
          for (let i = 0; i < 4; i += 1) { await sleep(i === 0 ? 700 : 450); await shot(`fun-${k}-act${i}`); }
        }
        await js(`window.__rht.setTimeScale(1); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = ""))`);
        continue;
      }
      if (s === "mapfx") {
        // Round 7 map features: the Ironworks rails glowing the turn before, then the train mid-run; a Karak pad launch;
        // a tank cracking Causeway ice; a barrel stack on each map.
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("ironworks", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
          const t = sim.mapDef.train.tracks[0]; sim.turn = sim.mapDef.train.startTurn - 1;
          const u = sim.debugSpawn("soldier", "enemy", { x: (t.minX + t.maxX) / 2 + 3, z: (t.minZ + t.maxZ) / 2 }); u.commandPoints = 0;
          r.setView({ x: (t.minX + t.maxX) / 2, z: (t.minZ + t.maxZ) / 2, zoom: 0.5, pitch: 0.7, yaw: 0.25 }); })()`);
        await sleep(900); await shot("mapfx-rails-soon");
        await js(`(() => { const sim = window.__rht.sim; sim.turn = sim.mapDef.train.startTurn; sim.endTurn(); window.__rht.setTimeScale(0.5); })()`);
        for (let i = 0; i < 4; i += 1) { await sleep(i === 0 ? 900 : 500); await shot("mapfx-train-" + i); }
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("karak", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const pad = sim.launchPads()[0];
          r.setView({ x: (pad.x + pad.to.x) / 2, z: (pad.z + pad.to.z) / 2, zoom: 0.55, pitch: 0.7, yaw: 0.2 }); })()`);
        await sleep(900); await shot("mapfx-pad");
        await js(`(() => { const r = window.__rht, sim = r.sim; const pad = sim.launchPads()[0]; const u = sim.debugSpawn("soldier", "player", { x: pad.x - 2, z: pad.z }); sim.debugSelect(u.id); sim.queueMove({ x: pad.x, z: pad.z }); r.deselect(); sim.endTurn(); window.__rht.setTimeScale(0.5); })()`);
        for (let i = 0; i < 4; i += 1) { await sleep(i === 0 ? 900 : 450); await shot("mapfx-launch-" + i); }
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("causeway", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const ice = sim.mapDef.terrain.ice[0]; const c = { x: (ice.minX + ice.maxX) / 2, z: (ice.minZ + ice.maxZ) / 2 };
          const t = sim.debugSpawn("tank", "player", c); t.crackedTurn = sim.turn - 1; const s2 = sim.debugSpawn("soldier", "player", { x: c.x, z: c.z + 3 });
          r.setView({ x: c.x, z: c.z, zoom: 0.5, pitch: 0.75, yaw: 0.2 }); })()`);
        await sleep(1000); await shot("mapfx-ice");
        for (const m of ["dustbowl", "verdant", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(m)}, "destroy", "normal")`);
          await sleep(1400);
          await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); const b = sim.entities.find((e) => e.coverKind === "barrels"); r.setView({ x: b.position.x, z: b.position.z, zoom: 0.3, pitch: 0.6, yaw: 0.3 }); })()`);
          await sleep(900); await shot("mapfx-barrels-" + m);
        }
        await js(`document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = ""))`);
        continue;
      }
      if (s === "hazards") {
        // Ironworks on turn 2: the slag spill strikes next turn, so its outline must already be on the ground.
        await js(`window.__rht.startBattle("ironworks", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.turn = 2; r.setView({ x: -8, z: 4, zoom: 0.45, pitch: 0.8, yaw: 0.3 }); })()`);
        await sleep(900); await shot("hazards-soon");
        await js(`(() => { window.__rht.sim.turn = 3; })()`);
        await sleep(900); await shot("hazards-now");
        continue;
      }
      if (s === "unselected") {
        // NOTHING selected, HUD hidden: every ring / disc still drawn around units and bases is a "default circle".
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", "bastion")`);
        await sleep(1800);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); document.querySelectorAll("#ui").forEach((e) => (e.style.visibility = "hidden"));
          ["soldier", "heavy", "juggernaut", "tank"].forEach((k, i) => sim.debugSpawn(k, "player", { x: -42 + i * 2.2, z: 5 }));
          sim.debugSpawn("soldier", "enemy", { x: -36, z: 9 });
          const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); r.setView({ x: hq.position.x + 2, z: hq.position.z + 3, zoom: 0.4, pitch: 0.8, yaw: 0.3 }); })()`);
        await sleep(1200); await shot("unselected-a");
        await js(`(() => { const r = window.__rht, sim = r.sim; r.setView({ x: -41, z: 5, zoom: 0.2, pitch: 0.7, yaw: 0.3 }); })()`);
        await sleep(800); await shot("unselected-units");
        continue;
      }
      if (s === "menupan") {
        // The title diorama over 15 seconds: it must sway gently in a front arc, never swing round behind the squad.
        await js(`window.__rht.toMenu()`);
        for (let i = 0; i < 4; i += 1) { await sleep(i === 0 ? 1500 : 4500); await shot("menupan-" + i); }
        continue;
      }
      if (s === "hopfilm") {
        // A trooper hops over a pillar (slow motion): crouch, arc, soft landing.
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); const u = sim.debugSpawn("skater", "player", { x: -12, z: 0 }); sim.debugCover("pillar", { x: -10, z: 0 }); sim.debugSelect(u.id); sim.queueLeap({ x: -7.6, z: 0 }); r.setView({ x: -10, z: 0, zoom: 0.22, pitch: 0.45, yaw: 0.6 }); sim.endTurn(); window.__rht.setTimeScale(0.3); })()`);
        for (let i = 0; i < 6; i += 1) { await sleep(i === 0 ? 700 : 260); await shot("hop-" + i); }
        await js(`window.__rht.setTimeScale(1)`);
        continue;
      }
      if (s === "hopflow") {
        // The real flow on Karak: pick a scout, press Hop (button), hover the far bank (arc preview), click, end turn, film it. Lands on the far bank, never in the river.
        await js(`window.__rht.setTimeScale(1); window.__rht.startBattle("karak", "destroy", "normal")`);
        await sleep(1800);
        await js(`(() => { const r = window.__rht, sim = r.sim; r.deselect(); sim.economy.set("enemy", 0); const u = sim.debugSpawn("skater", "player", { x: -12.4, z: 3 }); sim.debugSelect(u.id); window.__hopUnit = u.id; r.setView({ x: -10, z: 3, zoom: 0.3, pitch: 0.7, yaw: 0.5 }); })()`);
        await sleep(500);
        const hasBtn = await js(`Boolean(document.querySelector('[data-order-action="leap"]'))`);
        console.log("hopflow hop button", hasBtn);
        if (!hasBtn) throw new Error("no Hop button for an infantry unit");
        await js(`window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyJ" }))`); // the hotkey, not the button
        await sleep(200);
        const armed = await js(`window.__rht.sim.intent`);
        console.log("hopflow J arms", armed);
        if (armed !== "leap") throw new Error("the J hotkey did not arm Hop: " + armed);
        await js(`window.__rht.hoverGround({ x: -7.9, z: 3 })`);
        await sleep(700); await shot("hopflow-preview");
        await js(`window.__rht.clickWorld({ x: -7.9, z: 3 }, 0)`);
        await sleep(300);
        const queued = await js(`JSON.stringify(window.__rht.sim.orders.filter((o) => o.actorId === window.__hopUnit).map((o) => ({ k: o.kind, leap: o.leap, d: o.destination })))`);
        console.log("hopflow queued", queued);
        if (!/"leap":true/.test(queued)) throw new Error("clicking the far bank did not queue a hop: " + queued);
        await js(`window.__rht.setTimeScale(0.3); window.__rht.sim.endTurn()`);
        const heights = [];
        for (let i = 0; i < 8; i += 1) { await sleep(i === 0 ? 500 : 220); await shot("hopflow-" + i); heights.push(await js(`(() => { const e = window.__rht.sim.entity(window.__hopUnit); return JSON.stringify({ x: +e.position.x.toFixed(2), agl: +(e.agl || 0).toFixed(2), fly: !!e.flying }); })()`)); }
        await js(`window.__rht.setTimeScale(1)`);
        console.log("hopflow track", heights.join(" "));
        for (let i = 0; i < 40; i += 1) { if (await js(`window.__rht.sim.phase === "command"`)) break; await sleep(250); }
        const end = JSON.parse(await js(`(() => { const e = window.__rht.sim.entity(window.__hopUnit); return JSON.stringify({ x: e.position.x, z: e.position.z, fly: !!e.flying }); })()`));
        console.log("hopflow end", JSON.stringify(end));
        if (end.fly || end.x < -8.5) throw new Error("the hop did not land on the far bank: " + JSON.stringify(end));
        continue;
      }
      if (s === "glprobe") {
        // GL ERRORS PER FRAME (2026-10-01): wraps blitFramebuffer and polls getError over 2s of a battle.
        // A depth blit failed 144 times a second for weeks unseen (see stage.ts, NO DEPTH BLIT); any
        // non-zero error count here is a bug. Run after a postprocessing / three / n8ao bump.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2500);
        console.log("glprobe", await js(`(async () => {
          const gl = document.querySelector("canvas").getContext("webgl2");
          const stats = { blits: 0, blitErrors: 0, otherErrors: 0, depthBlits: 0 };
          const orig = gl.blitFramebuffer.bind(gl);
          gl.blitFramebuffer = (...a) => { stats.blits += 1; if (a[8] & gl.DEPTH_BUFFER_BIT) stats.depthBlits += 1; gl.getError(); orig(...a); if (gl.getError() !== 0) stats.blitErrors += 1; };
          const poll = setInterval(() => { if (gl.getError() !== 0) stats.otherErrors += 1; }, 16);
          await new Promise((r) => setTimeout(r, 2000));
          clearInterval(poll);
          return JSON.stringify(stats);
        })()`));
        continue;
      }
      if (s === "airghost") {
        // Deploy ghosts at true size (a Skyguard, a Gunship hanging in the air) and the gunship bomb run preview.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", "vanguard")`);
        await sleep(2200);
        for (const kind of ["flak", "gunship", "tank"]) {
          await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000); const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); hq.unlockedTech = window.__rht.techIds(); sim.select(hq.id); sim.setPendingDeploy(${JSON.stringify(kind)}); window.__rht.hoverGround({ x: hq.position.x + 6, z: hq.position.z + 2 }); window.__rht.setView({ x: hq.position.x + 5, z: hq.position.z + 1, zoom: 0.8, pitch: 0.7, yaw: 0.3 }); })()`);
          await sleep(1100); await shot("airghost-" + kind);
        }
        await js(`(() => { const sim = window.__rht.sim; sim.setPendingDeploy(undefined); window.__rht.deselect(); const g = sim.debugSpawn("gunship", "player", { x: -4, z: 0 }); sim.debugSpawn("heavy", "enemy", { x: 4, z: 1 }); sim.debugSpawn("soldier", "enemy", { x: 5.2, z: -0.5 }); sim.debugSelect(g.id); window.__rht.setIntent("grenade"); window.__rht.hoverGround({ x: 4, z: 1 }); window.__rht.setView({ x: 0, z: 0, zoom: 0.8, pitch: 0.8, yaw: 0.2 }); })()`);
        await sleep(1200); await shot("airghost-bombrun");
        continue;
      }
      if (s === "turnbanner") {
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(2200);
        await js(`window.__rht.endTurn()`);
        for (let i = 0; i < 80; i += 1) { await sleep(250); if (await js(`document.querySelector(".round-transition.show") ? true : false`)) break; }
        await sleep(500); await shot("turnbanner");
        continue;
      }
      if (s === "movefield") {
        // Move armed beside water / a mesa / a prop on three maps: red = cannot stand, cyan ring = reach.
        for (const [map, spot] of [["karak", { x: -8, z: 4 }], ["causeway", { x: -6, z: 0 }], ["ironworks", { x: -2, z: -6 }]]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(2200);
          await js(`(() => { const sim = window.__rht.sim; const u = sim.debugSpawn("soldier", "player", ${JSON.stringify(spot)}, { clearTerrain: true }); sim.debugSelect(u.id); window.__rht.setIntent("move"); window.__rht.setView({ x: u.position.x, z: u.position.z, zoom: 0.8, pitch: 0.85, yaw: 0.2 }); })()`);
          await sleep(1200); await shot("movefield-" + map);
        }
        continue;
      }
      if (s === "basesel") {
        // The REAL flow, camera untouched: battle opens on the player's base, the player picks it and a
        // unit to deploy. The whole deploy circle must be on screen and clear of the HUD panels.
        for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(2200);
          await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); sim.setPendingDeploy("soldier"); })()`);
          await sleep(2200);
          await shot("basesel-" + map);
        }
        continue;
      }
      if (s === "baserings") {
        // The base selected on every map: its selection ring + placement circle must read on each palette.
        for (const map of ["dustbowl", "ironworks", "verdant", "causeway", "karak", "crossfire"]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(2200);
          await js(`(() => { const sim = window.__rht.sim; const hq = sim.entities.find(e => e.team === "player" && e.kind === "base"); sim.select(hq.id); sim.setPendingDeploy("soldier"); window.__rht.setView({ x: hq.position.x + 2, z: hq.position.z, zoom: 1.05, pitch: 0.7, yaw: 0.25 }); })()`);
          await sleep(700);
          await shot("basering-" + map);
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
          const line = [["soldier", -3], ["heavy", -1.8], ["sniper", -0.6], ["flamer", 0.6], ["mortar", 1.8], ["tank", 3.4], ["chopbike", 5.2]];
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
        frames.forEach((f, i) => fs.writeFileSync(path.join(__dirname, "..", "shots", `gpu-temporal-f${i}.png`), f));
        fs.writeFileSync(path.join(__dirname, "..", "shots", "gpu-temporal-a.png"), frames[4]);
        fs.writeFileSync(path.join(__dirname, "..", "shots", "gpu-temporal-b.png"), frames[5]);
        console.log("shot: gpu-temporal.png (+ -a/-b full pair)");
        await js(`window.__rht.setResolveScale(1)`);
        await sleep(4000);
        continue;
      }
      if (s === "boot") {
        // The first six seconds after launch, then the skirmish intro flyover: frames at 300-400ms
        // so a flashing/flickering sequence is visible as a strip.
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
        await js(`(() => { const b = document.querySelector('[data-menu="play"]'); if (b) b.click(); })()`);
        await sleep(900);
        await js(`(() => { const f = document.querySelector(".start-flow"); for (let i = 0; i < 3 && Number(f.dataset.step) < 3; i += 1) document.querySelector('[data-step-go="next"]').click(); document.querySelector("[data-start]").click(); })()`);
        await sleep(200);
        await strip("boot-mission", 20, 300);
        continue;
      }
      if (s === "recon") {
        // Recon pulse ghost arrows + a deployed artillery piece on its outriggers.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000);
          const a = sim.debugSpawn("artillery", "player", { x: -6, z: 2 }); a.deployed = true; a.yaw = 0.3;
          sim.debugSpawn("skater", "player", { x: -3, z: -2 });
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
        await js(`(() => { const sim = window.__rht.sim; const t = sim.debugSpawn("tank", "player", { x: -2, z: 0 }); t.yaw = 0.6; const a = sim.debugSpawn("chopbike", "enemy", { x: 3.5, z: -2 }); a.yaw = 2.4; const s1 = sim.debugSpawn("soldier", "player", { x: 0.6, z: 1.6 }); s1.yaw = 0.4; const s2 = sim.debugSpawn("heavy", "player", { x: 1.8, z: 2.4 }); s2.yaw = 0.2; window.__rht.deselect(); window.__rht.setView({ x: 0.5, z: 0.5, zoom: 0.36, pitch: 0.5, yaw: 0.35 }); })()`);
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
          const m = sim.debugSpawn("breaker", "player", { x: 1, z: 2 }); m.yaw = 0.4;
          const d = sim.debugSpawn("skater", "player", { x: 2.4, z: 2.4 }); d.yaw = 0.2; d.stance = "prone";
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
          if (process.env.PROBE) console.log("near", map, await js(`(() => { const cam = window.__rht.cameraObject(); const out = []; for (const e of window.__rht.sim.entities) { const v = cam.position.clone().set(e.position.x, e.elevation + 0.5, e.position.z).project(cam); const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - v.y) / 2 * innerHeight; if (Math.hypot(sx - ${process.env.PX ?? 480}, sy - ${process.env.PY ?? 540}) < 90) out.push(e.kind + "/" + (e.coverKind ?? "") + " " + e.name + " @" + e.position.x.toFixed(1) + "," + e.position.z.toFixed(1)); } return JSON.stringify(out); })()`));
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
          const line = [["soldier", -3], ["heavy", -1.8], ["sniper", -0.6], ["flamer", 0.6], ["mortar", 1.8], ["tank", 3.4], ["chopbike", 5.2]];
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
      if (s === "tech") {
        // The base's Tech tab at 1600x900: fresh (nothing researched) and mid-game (a branch bought).
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        const openTech = async () => { await js(`(() => { const sim = window.__rht.sim; sim.economy.set("player", 9000); const base = sim.entities.find((e) => e.team === "player" && e.kind === "base"); sim.select(base.id); })()`); await sleep(500); await js(`(() => { const b = document.querySelector('[data-base-tab="tech"]'); if (b) b.click(); })()`); await sleep(600); };
        await openTech();
        await shot("tech-fresh");
        await js(`(() => { const base = window.__rht.sim.entities.find((e) => e.team === "player" && e.kind === "base"); base.unlockedTech = ["assault", "armor", "recon", "breach"]; })()`);
        await openTech();
        await shot("tech-mid");
        continue;
      }
      if (s === "hitreact") {
        // Per-part hit reaction: a marksman round to the HEAD of a Bastion trooper, resolve at a
        // quarter speed, eight frames -- the head should snap back and settle.
        await js(`window.__rht.startBattle("verdant", "destroy", "normal", "vanguard", "bastion")`);
        await sleep(2400);
        await js(`(() => { const r = window.__rht, s = r.sim; s.debugClearField(); s.economy.set("enemy", 0);
          const a = s.debugSpawn("sniper", "player", { x: -6, z: -9 }); a.yaw = Math.PI / 2;
          const b = s.debugSpawn("soldier", "enemy", { x: 2, z: -9 }); b.yaw = -Math.PI / 2;
          for (const p of b.parts) if (p.role === "weapon" || p.role === "mobility") p.hp = 0;
          s.debugSelect(a.id); s.queueShootPart(b.id, "head");
          r.setView({ x: 2, z: -9, zoom: 0.18, pitch: 0.25, yaw: 0 }); r.setResolveScale(0.25); r.endTurn(); })()`);
        // The resolve camera pulls out; pin the view on the target before every frame.
        for (let i = 0; i < 24; i += 1) { await sleep(200); await js(`window.__rht.setView({ x: 2, z: -9, zoom: 0.18, pitch: 0.25, yaw: 0 })`); await shot(`hitreact-${i}`); }
        await js(`window.__rht.setResolveScale(1)`);
        continue;
      }
      if (s === "hitreactprobe") {
        // Numbers, not frames: did a round hit the HEAD, and what did the head mesh's pitch do?
        await js(`window.__rht.startBattle("verdant", "destroy", "normal", "vanguard", "bastion")`);
        await sleep(2400);
        await js(`(() => { const r = window.__rht, s = r.sim; s.debugClearField(); s.economy.set("enemy", 0);
          const a = s.debugSpawn("soldier", "player", { x: -0.2, z: -9 }); a.yaw = Math.PI / 2;
          const b = s.debugSpawn("heavy", "enemy", { x: 1, z: -9 }); b.yaw = -Math.PI / 2; window.__probeId = b.id;
          for (const p of b.parts) if (p.role === "weapon") p.hp = 0; // legs stay intact: they are the part under test
          s.debugSelect(a.id); s.queueMeleePart(b.id, "legs"); r.endTurn(); window.__pitch = [];
          const t0 = performance.now();
          const tick = () => { let head; r.sceneObject().traverse((o) => { if (o.userData?.entityId === window.__probeId && o.userData?.partId === "legs" && o.userData?.segment === "thigh" && !head) head = o; });
            if (head) window.__pitch.push([Math.round(performance.now() - t0), +head.rotation.x.toFixed(3)]);
            if (performance.now() - t0 < 4000) requestAnimationFrame(tick); };
          requestAnimationFrame(tick); })()`);
        await sleep(4500);
        const out = await js(`(() => { const rep = window.__rht.sim.turnReports[0]; const hits = rep ? rep.entries.filter((e) => e.targetId === window.__probeId).map((e) => e.partId + ":" + e.amount) : [];
          const p = window.__pitch; const hitAt = window.__rht.sim.log.length ? 0 : 0;
          // The strike lands ~0.36s into the order (x4 wall time at normal pace ~ 0.4s): compare the
          // head pitch in the calm before it with the biggest excursion in the window after.
          const before = p.filter((q) => q[0] < 250).map((q) => q[1]);
          const after = p.filter((q) => q[0] >= 250 && q[0] < 1600).map((q) => q[1]);
          const rest = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
          const swing = after.length ? Math.max(...after.map((x) => Math.abs(x - rest))) : 0;
          const tgt = window.__rht.sim.entity(window.__probeId);
          const strikeLog = window.__rht.sim.log.filter((l) => /strikes|legs/i.test(l)).slice(0, 3);
          return JSON.stringify({ alive: tgt?.status.alive, legsHp: tgt?.parts.find((q) => q.id === "legs")?.hp, strikeLog, samples: p.length, restPitch: +rest.toFixed(3), maxSwingAfterHit: +swing.toFixed(3), idleWobbleBefore: before.length ? +(Math.max(...before) - Math.min(...before)).toFixed(3) : null }); })()`);
        console.log("hitreact probe: " + out);
        continue;
      }
      if (s === "sameside") {
        // The hardest team read: the SAME faction on both sides (Random can roll it, hotseat allows
        // it). Faction colour is shared, so team must still read from ring, trim and glow.
        await js(`window.__rht.startBattle("verdant", "destroy", "normal", "vanguard", "vanguard")`);
        await sleep(2400);
        await js(`(() => { const r = window.__rht, s = r.sim; s.debugClearField();
          ["soldier", "heavy", "sniper", "juggernaut"].forEach((k, i) => { const a = s.debugSpawn(k, "player", { x: -3, z: -12 + i * 1.6 }); a.yaw = Math.PI / 2;
            const b = s.debugSpawn(k, "enemy", { x: 3, z: -12 + i * 1.6 }); b.yaw = -Math.PI / 2; });
          r.deselect(); r.setView({ x: 0, z: -9.6, zoom: 0.42, pitch: 0.5, yaw: 0.9 }); })()`);
        await sleep(1800);
        await shot("sameside");
        continue;
      }
      if (s === "factions") {
        // One frame per faction: its HQ, a tank or APC, and a squad, player side, same framing, so
        // the three can be compared side by side (gpu-factions.png is the sheet).
        const sharp = require("sharp");
        const frames = [];
        for (const f of ["vanguard", "syndicate", "bastion"]) {
          await js(`window.__rht.startBattle("dustbowl", "destroy", "normal", "${f}", "${f === "vanguard" ? "bastion" : "vanguard"}")`);
          await sleep(1800);
          await js(`(() => { const sim = window.__rht.sim; const base = sim.entities.find((e) => e.team === "player" && e.kind === "base");
            const at = (dx, dz) => ({ x: base.position.x + dx, z: base.position.z + dz });
            const v = sim.debugSpawn("${f}" === "syndicate" ? "runabout" : "tank", "player", at(6, -3)); v.yaw = 1.2;
            ["soldier", "heavy", "sniper"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", at(4.5 + i * 1.2, 2.6)); u.yaw = 1.3; });
            window.__rht.deselect(); window.__rht.setView({ x: base.position.x + 3.6, z: base.position.z, zoom: 0.52, pitch: 0.5, yaw: 0.45 }); })()`);
          await sleep(1500);
          frames.push((await win.webContents.capturePage({ x: 280, y: 120, width: 1040, height: 600 })).toPNG());
          fs.writeFileSync(path.join(__dirname, "..", "shots", `gpu-faction-${f}.png`), frames[frames.length - 1]);
        }
        const tiles = await Promise.all(frames.map((b) => sharp(b).resize(780, 450).png().toBuffer()));
        await sharp({ create: { width: 780, height: 1350, channels: 3, background: "#000" } })
          .composite(tiles.map((input, i) => ({ input, left: 0, top: i * 450 }))).png()
          .toFile(path.join(__dirname, "..", "shots", "gpu-factions.png"));
        console.log("shot: gpu-factions.png");
        continue;
      }
      if (s === "versus") {
        // Local 2 Players: the set-up page, then the handoff card before Player 1 plans.
        await toTitle(); await clickMenu('[data-menu="play"]'); await toStep(2); await clickMenu('[data-opponent="local"]');
        await shot("versus-setup");
        await toStep(3); await clickMenu("[data-start]"); await sleep(2500);
        await shot("versus-handoff");
        continue;
      }
      if (s === "statuses") {
        // Every long roster status at once, for the "text runs through the health bar" class:
        // hull down, suppressed, crouched + grenades, deployed artillery, a hurt unit; then the Info panel.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim;
          const t = sim.debugSpawn("tank", "player", { x: -12, z: 2 }); t.hullDown = true;
          const h = sim.debugSpawn("heavy", "player", { x: -12, z: -1 }); h.suppressedUntilTurn = sim.turn + 1;
          const s1 = sim.debugSpawn("soldier", "player", { x: -13, z: 0 }); s1.stance = "crouched";
          const a = sim.debugSpawn("artillery", "player", { x: -14, z: 3 }); a.deployed = true;
          const g = sim.debugSpawn("molotov", "player", { x: -11, z: 1 }); g.parts.forEach((p) => { p.hp = Math.ceil(p.maxHp * 0.3); });
          sim.debugSpawn("striker", "player", { x: -12, z: 4 });
          window.__rht.deselect(); })()`);
        await sleep(1200);
        await shot("statuses");
        await js(`(() => { const b = document.querySelector("[data-detail]"); if (b) b.click(); })()`);
        await sleep(700);
        await shot("statuses-info");
        continue;
      }
      if (s === "deaths") {
        // Every death family at wall-clock speed on the real GPU: thrown (big blow), crumple, spin,
        // a tank wreck (turret thrown) and a gunship spiral. 16 frames at ~260ms = ~4.2s.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; window.__deaths = [];
          const put = (k, x, z) => { const u = sim.debugSpawn(k, "enemy", { x, z }); u.yaw = -1.2; window.__deaths.push(u.id); return u; };
          put("soldier", -6, 1); put("heavy", -3.5, 1); put("striker", -1, 1); put("tank", 3, 1.5); put("gunship", 8, 0);
          window.__rht.deselect(); })()`);
        await sleep(2000);
        await js(`window.__rht.setView(${process.env.DEATH_VIEW || "{ x: 1, z: -0.5, zoom: 0.5, pitch: 0.55, yaw: 0.2 }"})`);
        await sleep(500);
        await js(`window.__deaths.forEach((id, i) => window.__rht.debugKill(id, i === 0 ? 1 : 0))`);
        const sharp = require("sharp");
        const tiles = [];
        const t0 = Date.now(); const stamps = [];
        for (let i = 0; i < 16; i += 1) { tiles.push((await win.webContents.capturePage({ x: 250, y: 120, width: 1100, height: 619 })).toPNG()); stamps.push(Date.now() - t0); await sleep(60); }
        console.log("frame ms:", stamps.join(" "));
        const small = await Promise.all(tiles.map((b) => sharp(b).resize(400, 225).png().toBuffer()));
        await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#000" } })
          .composite(small.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 225 }))).png()
          .toFile(path.join(__dirname, "..", "shots", "gpu-deaths.png"));
        [2, 5, 8].forEach((i) => fs.writeFileSync(path.join(__dirname, "..", "shots", `gpu-deaths-f${i}.png`), tiles[i]));
        console.log("shot: gpu-deaths.png");
        continue;
      }
      if (s === "air") {
        // The four flyers, both teams, low over the field with a trooper for scale.
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim;
          ["gunship","bomber"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -7 + i * 5, z: 2.5 }); u.yaw = 0.5; });
          ["gunship","bomber"].forEach((k, i) => { const u = sim.debugSpawn(k, "enemy", { x: -4 + i * 6, z: -5 }); u.yaw = 2.6; });
          const s1 = sim.debugSpawn("soldier", "player", { x: 9.5, z: 2.5 }); s1.yaw = 0.5;
          window.__rht.deselect(); })()`);
        await sleep(2500);
        await js(`window.__rht.setView({ x: 0, z: -2, zoom: 0.8, pitch: 0.95, yaw: 0.35 })`);
        await sleep(600);
        await shot("air");
        await js(`window.__rht.setView({ x: -4.5, z: -1.5, zoom: 0.42, pitch: 0.9, yaw: 0.7 })`);
        await sleep(600);
        await shot("air-close");
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
            ["tank","chopbike","artillery"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -6 + i * 6, z: 2.5 }); u.yaw = 0.5; });
            ["tank","chopbike","artillery"].forEach((k, i) => { const u = sim.debugSpawn(k, "enemy", { x: -6 + i * 6, z: -4 }); u.yaw = 2.6; });
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
      if (s === "life") {
        // MAP LIFE: each map's emitting prop after a few seconds of running (smoke, flare, sparks,
        // chimney, dust devils); three frames apart on Ironworks for a strip.
        for (const [map, kind] of [["ironworks", "furnace"], ["dustbowl", "derrick"], ["karak", "brazier"], ["causeway", "hut"]]) {
          await js(`window.__rht.startBattle(${JSON.stringify(map)}, "destroy", "normal")`);
          await sleep(1500);
          await js(`(() => { const r = window.__rht, e = r.sim.entities.find((x) => x.coverKind === ${JSON.stringify(kind)}); r.deselect(); if (e) r.setView({ x: e.position.x, z: e.position.z + 2, zoom: 0.62, pitch: 0.5, yaw: 0.4 }); })()`);
          await sleep(4500);
          await shot(`life-${map}`);
          if (map === "ironworks") for (const k of [1, 2]) { await sleep(700); await shot(`life-${map}-${k}`); }
        }
        continue;
      }
      if (s === "heroprops") {
        // The Blender hero props (overhaul option 7), all nine kinds in two rows on a cleared field.
        await js(`window.__rht.startBattle("verdant", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; sim.debugClearField(); ["girder","coil","hedgehog","boat","obelisk","urn","iceblock","haybale","grave"].forEach((k, i) => sim.debugCover(k, { x: -8 + (i % 5) * 4, z: -9 + Math.floor(i / 5) * 4.5 })); window.__rht.deselect(); })()`);
        await sleep(2500);
        await js(`window.__rht.setView({ x: 0, z: -7, zoom: 0.42, pitch: 0.42, yaw: 0.35 })`);
        await sleep(800);
        await shot("heroprops");
        await js(`window.__rht.setView({ x: -4, z: -9, zoom: 0.26, pitch: 0.36, yaw: 0.5 })`);
        await sleep(800);
        await shot("heroprops-close");
        continue;
      }
      if (s === "lineup") {
        await js(`window.__rht.startBattle("dustbowl", "destroy", "normal")`);
        await sleep(1500);
        await js(`(() => { const sim = window.__rht.sim; ["soldier","skater","sniper","striker","heavy","molotov","mortar","flamer","jumper","breaker","boomer","juggernaut"].forEach((k, i) => { const u = sim.debugSpawn(k, "player", { x: -9 + i * 1.5, z: 0 }); u.yaw = 0.5; }); window.__rht.deselect(); })()`);
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
