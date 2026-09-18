// WALK-OVER-A-STEP FILMSTRIP. A soldier walks up onto a walkable terrain step (<= TERRAIN_STEP) and
// across a ground plate; 12 frames at half speed to shots/filmstrip-step.png. The check is feet:
// no boot inside the block face on the approach, no body sunk in the plate. Run: npm run shots:step
import { launchGame, delay } from "../improve/lib/harness.mjs";
import sharp from "sharp";
const { page, close } = await launchGame({ port: 5209, viewport: { width: 1200, height: 700 } });
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click('[data-map="dustbowl"]');
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
  const staged = await page.evaluate(() => {
    const sim = window.__rht.sim;
    // The lowest walkable block with flat floor beside it.
    const blocks = sim.mapDef.terrain.blocks.filter((b) => b.height > 0.3 && b.height <= 0.95);
    const b = blocks.sort((p, q) => p.height - q.height)[0];
    if (!b) return { ok: false };
    const z = (b.minZ + b.maxZ) / 2;
    const foot = { x: b.minX - 2.2, z };
    const top = { x: Math.min(b.maxX - 0.5, b.minX + 1.8), z };
    const actor = sim.debugSpawn("soldier", "player", foot);
    sim.select(actor.id);
    const queued = sim.queueMove(top);
    window.__rht.deselect();
    return { ok: queued, height: b.height, foot, top, id: actor.id };
  });
  console.log("staged", JSON.stringify(staged));
  await delay(600);
  await page.evaluate(() => { window.__rht.setResolveScale(0.1); window.__rht.endTurn(); });
  const frames = [];
  for (let i = 0; i < 12; i += 1) {
    // Follow the walker from the side so the block face and the boots are in profile.
    await page.evaluate((s) => { const a = window.__rht.sim.entity(s.id); window.__rht.setView({ x: a.position.x, z: a.position.z, zoom: 0.28, pitch: 0.28, yaw: 0 }); }, staged);
    frames.push(await page.screenshot({ clip: { x: 300, y: 120, width: 600, height: 420 } }));
    await delay(20);
  }
  const tiles = await Promise.all(frames.map((b) => sharp(b).resize(400, 280).png().toBuffer()));
  await sharp({ create: { width: 1600, height: 840, channels: 3, background: "#000" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * 280 })))
    .png().toFile("shots/filmstrip-step.png");
  await page.evaluate(() => window.__rht.setResolveScale(1));
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 }).catch(() => {});
  console.log("wrote shots/filmstrip-step.png");
} finally { await close(); }
