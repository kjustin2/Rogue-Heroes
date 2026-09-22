// LOCOMOTION FILMSTRIPS. 12 frames at reduced resolve speed to shots/filmstrip-<mode>.png.
//   step    a soldier walks up onto a walkable terrain step (<= TERRAIN_STEP) and across a ground
//           plate; the check is feet: no boot inside the block face, no body sunk in the plate.
//   walk    the line trooper's run on flat ground, side profile (the stride lock, knee break,
//           heel-toe roll, arm counter-swing and torso counter-twist are all judged HERE).
//   march   the scout's quick march (longer stride, more lean, pumping arms).
//   trudge  the heavy's trudge (short stride, long contact, wide stance, roll).
//   crouch  a soldier moving from a crouch: low, short steps.
// Run: npm run shots:step -- <mode>   (default: step)
import { launchGame, delay } from "../improve/lib/harness.mjs";
import sharp from "sharp";
import { mkdirSync } from "node:fs";
const MODE = process.argv[2] ?? "step";
const KIND = { march: "scout", trudge: "heavy" }[MODE] ?? "soldier";
mkdirSync("shots", { recursive: true });
const { page, close } = await launchGame({ port: 5209, viewport: { width: 1200, height: 700 } });
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click('[data-map="dustbowl"]');
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
  // Let the "deploying" card clear before the first frame.
  await delay(1800);
  const staged = await page.evaluate(({ mode, kind }) => {
    const sim = window.__rht.sim;
    // The lowest walkable block with flat floor beside it.
    const blocks = sim.mapDef.terrain.blocks.filter((b) => b.height > 0.3 && b.height <= 0.95);
    const b = blocks.sort((p, q) => p.height - q.height)[0];
    if (!b) return { ok: false };
    const flat = mode !== "step";
    const z = flat ? 2.5 : (b.minZ + b.maxZ) / 2;
    const foot = flat ? { x: -24, z } : { x: b.minX - 2.2, z };
    const top = flat ? { x: -14, z } : { x: Math.min(b.maxX - 0.5, b.minX + 1.8), z };
    const actor = sim.debugSpawn(kind, "player", foot);
    if (mode === "crouch") actor.stance = "crouched";
    sim.select(actor.id);
    const queued = sim.queueMove(top);
    window.__rht.deselect();
    return { ok: queued, height: b.height, foot, top, id: actor.id };
  }, { mode: MODE, kind: KIND });
  console.log("staged", JSON.stringify(staged));
  if (MODE !== "step") await page.addStyleTag({ content: "#ui, .toast { visibility: hidden !important; }" });
  await delay(300);
  // Slow enough that 12 frames ~120ms apart cover about one full stride of the tier.
  const scale = MODE === "step" ? 0.1 : MODE === "crouch" ? 0.25 : 0.12;
  await page.evaluate((s) => { window.__rht.setResolveScale(s); window.__rht.endTurn(); }, scale);
  const frames = [];
  for (let i = 0; i < 12; i += 1) {
    // Follow the walker. Step: the old 3/4 view so the block face reads. Flat modes: a true side
    // profile (camera on the unit's +z, the unit travels +x) framed on the body, close.
    await page.evaluate(({ s, mode }) => {
      const a = window.__rht.sim.entity(s.id);
      if (mode === "step") window.__rht.setView({ x: a.position.x, z: a.position.z, zoom: 0.28, pitch: 0.28, yaw: 0 });
      else window.__rht.setView({ x: a.position.x, z: a.position.z + 0.6, zoom: 0.19, pitch: 0.14, yaw: 0.588 });
    }, { s: staged, mode: MODE });
    await delay(30);
    frames.push(await page.screenshot({ clip: MODE === "step" ? { x: 300, y: 120, width: 600, height: 420 } : { x: 350, y: 30, width: 500, height: 420 } }));
    await delay(90);
  }
  const tiles = await Promise.all(frames.map((b) => sharp(b).resize(400, MODE === "step" ? 280 : 336).png().toBuffer()));
  const th = MODE === "step" ? 280 : 336;
  await sharp({ create: { width: 1600, height: th * 3, channels: 3, background: "#000" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % 4) * 400, top: Math.floor(i / 4) * th })))
    .png().toFile(`shots/filmstrip-${MODE}.png`);
  await page.evaluate(() => window.__rht.setResolveScale(1));
  await page.waitForFunction(() => window.__rht.sim.phase === "command", null, { timeout: 30000 }).catch(() => {});
  console.log(`wrote shots/filmstrip-${MODE}.png`);
} finally { await close(); }
