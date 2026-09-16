// Damaged-parts look: a line of troopers each missing one part (weapon, pack, legs) plus a tank
// with a dead left tread, so the physical read of per-part damage can be checked by eye.
import { launchGame, delay } from "../improve/lib/harness.mjs";
const { page, close } = await launchGame({ port: 5203, viewport: { width: 1400, height: 800 } });
try {
  await page.waitForSelector(".main-menu");
  await page.click('[data-menu="play"]');
  await page.waitForSelector("[data-map]");
  await page.click('[data-map="dustbowl"]');
  await page.click("[data-start]");
  await page.waitForFunction(() => window.__rht?.sim?.phase === "command", null, { timeout: 20000 });
  await page.evaluate(() => {
    const sim = window.__rht.sim;
    const kill = (e, id) => { const p = e.parts.find((p) => p.id === id); if (p) p.hp = 0; };
    const a = sim.debugSpawn("soldier", "player", { x: -3, z: 0 });
    const b = sim.debugSpawn("soldier", "player", { x: -1.5, z: 0 }); kill(b, "rifle");
    const c = sim.debugSpawn("soldier", "player", { x: 0, z: 0 }); kill(c, "pack");
    const d = sim.debugSpawn("soldier", "player", { x: 1.5, z: 0 }); kill(d, "legs");
    const t = sim.debugSpawn("tank", "player", { x: 4.5, z: 0 }); kill(t, "left-tread");
    for (const e of [a, b, c, d, t]) e.yaw = 0;
    window.__rht.setView({ x: 0.8, z: 0.5, zoom: 0.42, pitch: 0.5, yaw: 0.1 });
    window.__rht.deselect();
  });
  await delay(1500);
  await page.screenshot({ path: "shots/damage-parts.png", clip: { x: 200, y: 150, width: 1000, height: 450 } });
  console.log("wrote shots/damage-parts.png");
} finally { await close(); }
