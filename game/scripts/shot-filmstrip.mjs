// ATTACK FILMSTRIP. Stages one attack between a player unit and an enemy at close range, resolves
// it and captures 12 frames through the swing/flight to shots/filmstrip-<kind>.png. Motion is
// judged on filmstrips, not stills. Run: npm run shots:filmstrip -- melee   (or any key below)
//
// Projectile families each have a stage so a round's in-flight look, its muzzle event and its
// impact can be reviewed as motion: shoot (rifle tracer), heavy (MG burst), sniper (pierce line),
// sapper (shotgun pellets), pistol (medic sidearm), flame (flamer stream), grenade (thrown arc),
// launcher (grenadier), mortar (high arc), tank (AP shell), artillery (siege shell), apc (autogun
// bolt), turret (bolt), gunship (air gun + bombs). `all` runs every projectile stage in one go.
import { launchGame, delay } from "../improve/lib/harness.mjs";
import sharp from "sharp";

// dist: actor at x=-0.7, target at x=dist-0.7 (z=0). zoom: smaller = further out. scale: resolve
// clock scale. gap: ms between frames. order: sim queue call. targetKind: what stands downrange.
const STAGES = {
  melee: { actor: "striker", target: "heavy", dist: 1.4, order: "melee", zoom: 0.45, scale: 0.25, gap: 40 },
  kill: { actor: "striker", target: "heavy", dist: 1.4, order: "melee", zoom: 0.45, scale: 0.25, gap: 120 },
  shoot: { actor: "soldier", target: "soldier", dist: 3.9, order: "shoot", zoom: 0.45, scale: 0.5, span: 2.2 },
  heavy: { actor: "heavy", target: "soldier", dist: 5.2, order: "shoot", zoom: 0.55, scale: 0.5, span: 3.3 },
  sniper: { actor: "sniper", target: "soldier", dist: 7.5, order: "shoot", zoom: 0.72, scale: 0.5, span: 3.1 },
  sapper: { actor: "sapper", target: "soldier", dist: 3.6, order: "shoot", zoom: 0.45, scale: 0.5, span: 2.2 },
  pistol: { actor: "medic", target: "soldier", dist: 3.9, order: "shoot", zoom: 0.45, scale: 0.5, span: 2.2 },
  flame: { actor: "flamer", target: "soldier", dist: 4.2, order: "shoot", zoom: 0.5, scale: 0.5, span: 2.4 },
  grenade: { actor: "soldier", target: "soldier", dist: 6.5, order: "grenade", zoom: 0.7, scale: 0.5, span: 4.2 },
  launcher: { actor: "grenadier", target: "soldier", dist: 7.5, order: "shoot", zoom: 0.75, scale: 0.5, span: 4.8 },
  mortar: { actor: "mortar", target: "soldier", dist: 10, order: "shoot", zoom: 0.95, scale: 0.5, span: 6.1 },
  tank: { actor: "tank", target: "soldier", dist: 8.5, order: "shoot", zoom: 0.8, scale: 0.5, span: 4.7 },
  artillery: { actor: "artillery", target: "soldier", dist: 11, order: "shoot", zoom: 1.0, scale: 0.5, span: 5.7 },
  apc: { actor: "apc", target: "soldier", dist: 7, order: "shoot", zoom: 0.7, scale: 0.5, span: 3.6 },
  turret: { actor: "turret", target: "soldier", dist: 6.5, order: "shoot", zoom: 0.7, scale: 0.5, span: 3.4 },
  gunship: { actor: "gunship", target: "gunship", dist: 7, order: "shoot", zoom: 0.75, scale: 0.5, span: 3.3 },
  // "through": the target stands just behind a prop on the line of fire. The rounds must stop AT
  // the prop (chip effect) or clearly clear it — never pass through the mesh.
  "through-crate": { actor: "soldier", target: "soldier", dist: 6.4, order: "shoot", zoom: 0.55, scale: 0.4, span: 3.2, cover: "crate", coverAt: 0.55 },
  "through-sandbag": { actor: "heavy", target: "soldier", dist: 6.4, order: "shoot", zoom: 0.55, scale: 0.4, span: 3.2, cover: "sandbag", coverAt: 0.55 },
  "through-rock": { actor: "sniper", target: "soldier", dist: 8, order: "shoot", zoom: 0.65, scale: 0.4, span: 3.6, cover: "rock", coverAt: 0.5 },
  "through-incover": { actor: "soldier", target: "soldier", dist: 6.4, order: "shoot", zoom: 0.55, scale: 0.4, span: 3.2, cover: "sandbag", coverAt: 0.82 },
  "through-wall": { actor: "soldier", target: "soldier", dist: 7, order: "shoot", zoom: 0.6, scale: 0.4, span: 3.4, wall: true, coverAt: 0.5 },
  "through-tree": { actor: "soldier", target: "soldier", dist: 7, order: "shoot", zoom: 0.6, scale: 0.4, span: 3.4, cover: "tree", coverAt: 0.5 },
};
const PROJECTILE_STAGES = ["through-crate", "through-sandbag", "through-rock", "through-tree", "shoot", "heavy", "sniper", "sapper", "pistol", "flame", "grenade", "launcher", "mortar", "tank", "artillery", "apc", "turret", "gunship"];

const FRAME_COST = 180;
const arg = process.argv[2] ?? "melee";
const kinds = arg === "all" ? PROJECTILE_STAGES : [arg];
if (!kinds.every((k) => k === "jump" || STAGES[k])) throw new Error(`unknown filmstrip kind ${arg}; known: jump ${Object.keys(STAGES).join(" ")}`);

const { page, close } = await launchGame({ port: 5200, viewport: { width: 1200, height: 700 } });
try {
  let first = true;
  for (const KIND of kinds) {
    const stage = STAGES[KIND];
    if (!first) await page.goto(page.url(), { waitUntil: "networkidle" }); // fresh sim per stage
    first = false;
    await page.waitForSelector(".main-menu");
    await page.click('[data-menu="play"]');
    await page.waitForSelector("[data-map]");
    await page.click(KIND === "jump" ? '[data-map="causeway"]' : "[data-map]");
    await page.click("[data-start]");
    await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
    // The round banner and the first-run hint would otherwise sit over the impact frames.
    await page.addStyleTag({ content: ".round-transition, .hint, .toast { display: none !important; }" }).catch(() => {});
    const ok = await page.evaluate(({ kind, stage }) => {
      const sim = window.__rht.sim;
      sim.economy.set("player", 9000);
      if (kind === "jump") {
        // A jump onto the nearest real cliff (a block taller than a step, flat ground at its foot).
        const blocks = sim.mapDef.terrain.blocks.filter((b) => b.height > 1.5);
        const b = blocks[0];
        const top = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
        const foot = { x: b.minX - 4, z: top.z };
        const actor = sim.debugSpawn("jumper", "player", foot);
        sim.select(actor.id);
        const queued = sim.queueMove(top);
        window.__rht.setView({ x: (foot.x + top.x) / 2, z: top.z, zoom: 0.5, pitch: 0.55, yaw: 0.8 });
        window.__rht.deselect();
        return { queued, why: queued ? "" : sim.log.slice(0, 2), orders: sim.orders.length };
      }
      const actor = sim.debugSpawn(stage.actor, "player", { x: -0.7, z: 0 });
      const target = sim.debugSpawn(stage.target, "enemy", { x: stage.dist - 0.7, z: 0 });
      if (stage.cover) sim.debugCover(stage.cover, { x: -0.7 + stage.dist * stage.coverAt, z: 0.15 });
      // A blast wall across the line, offset so the round crosses its OUTER third (the old disc let it through).
      if (stage.wall) { const w = sim.debugBuild("wall", "enemy", { x: -0.7 + stage.dist * stage.coverAt, z: 0.8 }); w.yaw = Math.PI / 2; }
      // "kill": the target is one hit from dead, so the strip shows the death fall.
      if (kind === "kill") for (const p of target.parts) p.hp = Math.min(p.hp, 4);
      // The target must not shoot back in the same resolve, or the strip shows the actor's death
      // instead of the attack. Kill its weapon part; status re-derives from parts each turn.
      for (const part of target.parts) if (part.role === "weapon" || part.role === "mobility") part.hp = 0;
      target.status.canShoot = false;
      target.status.canMove = false; // ...and must not walk out of frame either
      if (stage.order === "grenade") actor.grenades = Math.max(1, actor.grenades ?? 0);
      sim.select(actor.id);
      sim.setIntent(stage.order);
      const queued = stage.order === "melee" ? sim.queueMelee(target.id)
        : stage.order === "grenade" ? sim.queueGrenade(target.id)
        : sim.queueShoot(target.id);
      if (kind === "kill") { const o = sim.orders[sim.orders.length - 1]; if (o) o.aim = "center"; }
      const why = queued ? "" : sim.log.slice(0, 2);
      window.__rht.setView({ x: (stage.dist - 1.4) / 2, z: 0, zoom: stage.zoom, pitch: 0.5, yaw: 0.9 });
      window.__rht.deselect();
      return { queued, why, orders: sim.orders.length, cp: actor.commandPoints, canMove: actor.status.canMove };
    }, { kind: KIND, stage: stage ?? {} });
    console.log(KIND, "staged", JSON.stringify(ok));
    await delay(1400); // let the deploy overlay clear
    // Slowed resolve: headless screenshots cost ~150ms each, so at full speed twelve frames straddle
    // the whole action and show nothing of it.
    await page.evaluate(({ kind, stage }) => { window.__rht.setResolveScale(kind === "jump" ? 0.35 : stage.scale); window.__rht.endTurn(); }, { kind: KIND, stage: stage ?? {} });
    const frames = [];
    // A kill strip starts at the impact, not the wind-up: wait for the log line, then film.
    if (KIND === "kill") await page.waitForFunction(() => window.__rht.sim.log.some((l) => l.includes("killed by")), null, { timeout: 15000 }).catch(() => {});
    // A projectile strip starts when the round leaves the barrel, not during the wind-up, so the
    // twelve frames cover flight + impact instead of the aim pose.
    if (PROJECTILE_STAGES.includes(KIND)) await page.waitForFunction(() => window.__rht.sim.projectiles.length > 0, null, { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 12; i += 1) {
      // Pin the camera every frame: the resolve director otherwise pans off to whatever it rates.
      if (KIND !== "jump") await page.evaluate((s) => window.__rht.setView({ x: (s.dist - 1.4) / 2, z: 0, zoom: s.zoom, pitch: 0.5, yaw: 0.9 }), stage);
      frames.push(await page.screenshot({ clip: { x: 300, y: 120, width: 600, height: 420 } }));
      // A screenshot + camera pin costs ~FRAME_COST ms of wall clock; the gap fills out the span.
      await delay(KIND === "jump" ? 40 : stage.span ? Math.max(0, (stage.span * 1000) / (12 * stage.scale) - FRAME_COST) : stage.gap);
    }
    const tiles = await Promise.all(frames.map((b) => sharp(b).resize(400, 280).png().toBuffer()));
    await sharp({ create: { width: 1600, height: 840, channels: 3, background: "#000" } })
      .composite(tiles.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 280 })))
      .png().toFile(`shots/filmstrip-${KIND}.png`);
    await page.evaluate(() => window.__rht.setResolveScale(1));
    await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 }).catch(() => {});
    console.log("log:", JSON.stringify(await page.evaluate(() => window.__rht.sim.log.slice(0, 12).reverse())));
    console.log(`wrote shots/filmstrip-${KIND}.png`);
  }
} finally { await close(); }
