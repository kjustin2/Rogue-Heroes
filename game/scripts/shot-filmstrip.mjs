// ATTACK FILMSTRIP. Stages one attack (melee | shoot) between a player unit and an enemy at close
// range, resolves it and captures 12 frames through the swing to shots/filmstrip-<kind>.png. Motion
// is judged on filmstrips, not stills. Run: npm run shots:filmstrip -- melee   (or shoot)
import { launchGame, delay } from "../improve/lib/harness.mjs";
import sharp from "sharp";
const KIND = process.argv[2] ?? "melee";
const { page, close } = await launchGame({ port: 5200, viewport: { width: 1200, height: 700 } });
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click(KIND === "jump" ? '[data-map="causeway"]' : "[data-map]");
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
  const ok = await page.evaluate((kind) => {
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
    const actor = sim.debugSpawn(kind === "melee" ? "striker" : "soldier", "player", { x: -0.7, z: 0 });
    const target = sim.debugSpawn(kind === "melee" ? "heavy" : "soldier", "enemy", { x: kind === "melee" ? 0.7 : 3.2, z: 0 });
    // The target must not shoot back in the same resolve, or the strip shows the striker's death
    // instead of the strike. Kill its weapon part; status re-derives from parts each turn.
    for (const part of target.parts) if (part.role === "weapon" || part.role === "mobility") part.hp = 0;
    target.status.canShoot = false;
    target.status.canMove = false; // ...and must not walk out of frame either
    sim.select(actor.id);
    sim.setIntent(kind);
    const queued = kind === "melee" ? sim.queueMelee(target.id) : sim.queueShoot(target.id);
    const why = queued ? "" : sim.log.slice(0, 2);
    window.__rht.setView({ x: kind === "melee" ? 0 : 1.2, z: 0, zoom: 0.45, pitch: 0.5, yaw: 0.9 });
    window.__rht.deselect();
    return { queued, why, orders: sim.orders.length, cp: actor.commandPoints, canMove: actor.status.canMove };
  }, KIND);
  console.log("staged", JSON.stringify(ok));
  await delay(600);
  // Quarter-speed resolve: headless screenshots cost ~150ms each, so at full speed nine frames
  // straddle the whole 0.78s swing and show nothing of it.
  await page.evaluate((k) => { window.__rht.setResolveScale(k === "melee" ? 0.25 : k === "jump" ? 0.35 : 0.5); window.__rht.endTurn(); }, KIND);
  const frames = [];
  for (let i = 0; i < 12; i += 1) {
    // Pin the camera every frame: the resolve director otherwise pans off to whatever it rates.
    if (KIND !== "jump") await page.evaluate((k) => window.__rht.setView({ x: k === "melee" ? 0 : 1.2, z: 0, zoom: 0.45, pitch: 0.5, yaw: 0.9 }), KIND);
    frames.push(await page.screenshot({ clip: { x: 300, y: 120, width: 600, height: 420 } }));

    await delay(40);
  }
  const tiles = await Promise.all(frames.map((b) => sharp(b).resize(400, 280).png().toBuffer()));
  await sharp({ create: { width: 1600, height: 840, channels: 3, background: "#000" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 280 })))
    .png().toFile(`shots/filmstrip-${KIND}.png`);
  await page.evaluate(() => window.__rht.setResolveScale(1));
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 }).catch(() => {});
  console.log("log:", JSON.stringify(await page.evaluate(() => window.__rht.sim.log.slice(0, 20).reverse())));
  console.log(`wrote shots/filmstrip-${KIND}.png`);
} finally { await close(); }
